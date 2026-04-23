"""
FreeLAD - Free Lightweight Architectural Display
A multiplayer 3D virtual world server for viewing and interacting with STL models.
"""

import os
import uuid
import json
import io
import time
import zipfile
from datetime import datetime
from flask import Flask, send_from_directory, request, jsonify, send_file
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = "freelad-dev"

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    max_http_buffer_size=50 * 1024 * 1024,
    ping_interval=5,   # Ping every 5s (default 25)
    ping_timeout=10,   # Disconnect if no pong in 10s (default 20)
)

STL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stl_files")

# Admin password is read from env or set later from CLI args in __main__.
# Module-scope default so WSGI deployments (without __main__) still work.
ADMIN_PASSWORD = os.environ.get("FREELAD_ADMIN_PASSWORD", "admin")
os.makedirs(STL_DIR, exist_ok=True)

# World state
players = {}  # sid -> {id, name, position, rotation, color}
stl_models = {}  # model_id -> {id, filename, position, rotation, scale, original_name}
admin_sids = set()  # socket IDs that have authenticated as admin

# Admin settings
admin_settings = {
    "editing_enabled": True,   # whether non-admin clients can edit/delete models
    "upload_enabled": True,    # whether non-admin clients can upload models
    "max_bbox": 0,             # max bounding box dimension for uploads (0 = unlimited)
    "movement_mult": 1.0,      # scales all player movement speeds
    "jump_mult": 1.0,          # scales jump height
}

# Game mode state: "sandbox" (default) or "ctf"
game_mode = "sandbox"

# CTF state (used only when game_mode == "ctf")
ctf_state = {
    "phase": "pregame",                       # "pregame" or "playing"
    "teams": {},                              # sid -> "red" | "blue" (absent = spectator)
    "spawns": {"red": None, "blue": None},    # [x, y, z]
    "flag_home": {"red": None, "blue": None}, # [x, y, z]
    "flag_pos": {"red": None, "blue": None},  # current flag position
    "flag_holder": {"red": None, "blue": None}, # sid of player carrying, or None
    "scores": {"red": 0, "blue": 0},
}


def ctf_public_state():
    """CTF state safe to broadcast (no internal references)."""
    return {
        "phase": ctf_state["phase"],
        "teams": dict(ctf_state["teams"]),
        "spawns": ctf_state["spawns"],
        "flag_home": ctf_state["flag_home"],
        "flag_pos": ctf_state["flag_pos"],
        "flag_holder": ctf_state["flag_holder"],
        "scores": ctf_state["scores"],
        "countdown_end_ts": ctf_state.get("countdown_end_ts"),
    }


def broadcast_game_state():
    """Broadcast current game mode and CTF state to all clients."""
    socketio.emit("game_state", {
        "mode": game_mode,
        "ctf": ctf_public_state() if game_mode == "ctf" else None,
    })

def meta_path(stl_filename):
    """Return the path to the metadata JSON file for an STL."""
    return os.path.join(STL_DIR, stl_filename + ".json")


def save_meta(model):
    """Write a model's metadata to its companion JSON file."""
    data = {
        "original_name": model.get("original_name", model["filename"]),
        "position": model["position"],
        "rotation": model["rotation"],
        "scale": model["scale"],
        "color": model.get("color", "#aaaacc"),
    }
    try:
        with open(meta_path(model["filename"]), "w") as f:
            json.dump(data, f, indent=2)
    except OSError as ex:
        print(f"[!] Failed to save metadata for {model['filename']}: {ex}")


def load_meta(stl_filename):
    """Load metadata from companion JSON, or return defaults."""
    mp = meta_path(stl_filename)
    if os.path.exists(mp):
        try:
            with open(mp) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return None


# Load existing STL files from disk on startup
def load_existing_stls():
    for filename in os.listdir(STL_DIR):
        if filename.lower().endswith(".stl"):
            model_id = str(uuid.uuid4())
            meta = load_meta(filename)
            stl_models[model_id] = {
                "id": model_id,
                "filename": filename,
                "original_name": meta["original_name"] if meta else filename,
                "position": meta["position"] if meta else [0, 0, 0],
                "rotation": meta["rotation"] if meta else [0, 0, 0],
                "scale": meta["scale"] if meta else [1, 1, 1],
                "color": meta["color"] if meta else "#aaaacc",
            }

load_existing_stls()


CTF_MAP_FILE = os.path.join(STL_DIR, "ctf_map.json")


def save_ctf_map():
    """Persist flag homes and spawn positions to disk (inside STL_DIR so they're part of scene zips)."""
    data = {
        "flag_home": ctf_state["flag_home"],
        "spawns": ctf_state["spawns"],
    }
    try:
        with open(CTF_MAP_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except OSError:
        pass


def load_ctf_map():
    """Load flag homes and spawn positions from disk, if available."""
    if not os.path.exists(CTF_MAP_FILE):
        return
    try:
        with open(CTF_MAP_FILE) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return
    if "flag_home" in data:
        for t in ("red", "blue"):
            ctf_state["flag_home"][t] = data["flag_home"].get(t)
            if ctf_state["flag_home"][t]:
                ctf_state["flag_pos"][t] = list(ctf_state["flag_home"][t])
    if "spawns" in data:
        for t in ("red", "blue"):
            ctf_state["spawns"][t] = data["spawns"].get(t)


load_ctf_map()


# Assign colors to players
PLAYER_COLORS = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#e91e63", "#00bcd4", "#8bc34a",
]
color_index = 0


def next_color():
    global color_index
    c = PLAYER_COLORS[color_index % len(PLAYER_COLORS)]
    color_index += 1
    return c


def is_admin(sid):
    return sid in admin_sids


def can_edit(sid):
    """Can this client edit/delete/transform models?"""
    if is_admin(sid):
        return True
    # During CTF, only admins can edit
    if game_mode == "ctf":
        return False
    return admin_settings["editing_enabled"]


def broadcast_admin_state(target_sid=None):
    """Send current admin settings and model list to an admin client."""
    data = {
        "settings": admin_settings,
        "models": [
            {"id": m["id"], "name": m["original_name"]}
            for m in stl_models.values()
        ],
        "players": [
            {"id": p["id"], "name": p["name"], "team": ctf_state["teams"].get(p["id"])}
            for p in players.values()
        ],
        "game_mode": game_mode,
    }
    if target_sid:
        emit("admin_state", data, to=target_sid)
    else:
        for sid in admin_sids:
            socketio.emit("admin_state", data, to=sid)


# --- HTTP Routes ---

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/stl_files/<path:filename>")
def serve_stl(filename):
    return send_from_directory(STL_DIR, filename)


@app.route("/upload_stl", methods=["POST"])
def upload_stl():
    # Enforce upload lock for non-admins (always locked during CTF mode)
    uploader = request.form.get("uploader", "")
    if not is_admin(uploader):
        if game_mode == "ctf":
            return jsonify({"error": "Uploads disabled during CTF mode"}), 403
        if not admin_settings["upload_enabled"]:
            return jsonify({"error": "Uploads are currently disabled"}), 403

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f = request.files["file"]
    if not f.filename.lower().endswith(".stl"):
        return jsonify({"error": "Only STL files are accepted"}), 400

    # Save with a safe unique name
    original_name = f.filename
    safe_name = f"{uuid.uuid4().hex}_{original_name}"
    filepath = os.path.join(STL_DIR, safe_name)
    f.save(filepath)

    # Replace-existing flow: swap the file but keep the model's transforms/color
    replace_id = request.form.get("replace_id", "").strip()
    if replace_id and replace_id in stl_models:
        old_model = stl_models[replace_id]
        old_filepath = os.path.join(STL_DIR, old_model["filename"])
        old_metapath = meta_path(old_model["filename"])
        if os.path.exists(old_filepath):
            os.remove(old_filepath)
        if os.path.exists(old_metapath):
            os.remove(old_metapath)
        old_model["filename"] = safe_name
        old_model["original_name"] = original_name
        save_meta(old_model)
        socketio.emit("stl_file_replaced", old_model)
        broadcast_admin_state()
        return jsonify(old_model)

    try:
        scale = float(request.form.get("scale", 1))
    except (TypeError, ValueError):
        scale = 1

    try:
        position = json.loads(request.form.get("position", "[0, 0, 0]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        position = [0, 0, 0]

    color = request.form.get("color", "#aaaacc")

    model_id = str(uuid.uuid4())
    stl_models[model_id] = {
        "id": model_id,
        "filename": safe_name,
        "original_name": original_name,
        "position": position,
        "rotation": [0, 0, 0],
        "scale": [scale, scale, scale],
        "color": color,
    }

    save_meta(stl_models[model_id])

    # Broadcast new model to all clients (autoLift tells clients to adjust Y)
    broadcast_data = {
        **stl_models[model_id],
        "autoLift": True,
        "uploader": uploader,
        "maxBbox": admin_settings["max_bbox"],
    }
    socketio.emit("stl_added", broadcast_data)

    # Update admin panels
    broadcast_admin_state()

    return jsonify(stl_models[model_id])


@app.route("/api/stl_models")
def list_stl_models():
    return jsonify(list(stl_models.values()))


@app.route("/admin/save_scene")
def admin_save_scene():
    """Bundle all STL files and their metadata JSONs into a zip for download. Admin-only."""
    token = request.args.get("token", "")
    if token not in admin_sids:
        return jsonify({"error": "Admin authentication required"}), 403
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename in os.listdir(STL_DIR):
            filepath = os.path.join(STL_DIR, filename)
            if os.path.isfile(filepath):
                zf.write(filepath, arcname=filename)
    buf.seek(0)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"freelad_scene_{timestamp}.zip")


@app.route("/admin/load_scene", methods=["POST"])
def admin_load_scene():
    """Replace all current STLs with contents of an uploaded zip. Admin-only."""
    token = request.form.get("token", "")
    if token not in admin_sids:
        return jsonify({"error": "Admin authentication required"}), 403
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f = request.files["file"]
    try:
        data = f.read()
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return jsonify({"error": "Not a valid zip file"}), 400

    # Validate contents before wiping anything
    for name in zf.namelist():
        if name.endswith("/") or ".." in name or name.startswith("/") or os.path.isabs(name):
            return jsonify({"error": f"Invalid path in zip: {name}"}), 400
        if not (name.lower().endswith(".stl") or name.lower().endswith(".json")):
            return jsonify({"error": f"Only .stl and .json files allowed in zip: {name}"}), 400

    # Atomic-ish swap: extract to a temp directory first so an extraction failure
    # doesn't leave us with a half-wiped scene.
    tmp_dir = os.path.join(STL_DIR, f".tmp_load_{uuid.uuid4().hex}")
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        zf.extractall(tmp_dir)
    except Exception as ex:
        for fn in os.listdir(tmp_dir):
            try: os.remove(os.path.join(tmp_dir, fn))
            except OSError: pass
        try: os.rmdir(tmp_dir)
        except OSError: pass
        return jsonify({"error": f"Failed to extract zip: {ex}"}), 500

    # Extraction succeeded - wipe current scene and move extracted files in
    for filename in os.listdir(STL_DIR):
        if filename.startswith(".tmp_load_"):
            continue
        filepath = os.path.join(STL_DIR, filename)
        if os.path.isfile(filepath):
            os.remove(filepath)
    for filename in os.listdir(tmp_dir):
        os.replace(os.path.join(tmp_dir, filename), os.path.join(STL_DIR, filename))
    try: os.rmdir(tmp_dir)
    except OSError: pass

    # Rebuild in-memory model list
    stl_models.clear()
    load_existing_stls()

    # Also restore CTF map layout (flag homes + spawns) if the zip included one
    # Clear existing first so missing file means cleared state
    ctf_state["flag_home"] = {"red": None, "blue": None}
    ctf_state["spawns"]    = {"red": None, "blue": None}
    ctf_state["flag_pos"]  = {"red": None, "blue": None}
    load_ctf_map()

    # Broadcast full scene refresh to all clients
    socketio.emit("scene_reloaded", {"models": list(stl_models.values())})
    if game_mode == "ctf":
        broadcast_game_state()
    broadcast_admin_state()
    print(f"[ADMIN] Scene loaded from uploaded zip ({len(stl_models)} models)")
    return jsonify({"ok": True, "count": len(stl_models)})


# --- Socket.IO Events ---

@socketio.on("connect")
def on_connect():
    sid = request.sid
    color = next_color()
    players[sid] = {
        "id": sid,
        "name": f"Player-{sid[:6]}",
        "position": [0, 1.0, 0],
        "rotation": [0, 0, 0],
        "color": color,
        "last_seen_ts": time.time(),
    }

    # Send the new player their info and current world state
    emit("welcome", {
        "you": players[sid],
        "players": {k: v for k, v in players.items() if k != sid},
        "stl_models": list(stl_models.values()),
        "editing_enabled": admin_settings["editing_enabled"],
        "upload_enabled": admin_settings["upload_enabled"],
        "lighting": admin_settings.get("lighting"),
        "movement_mult": admin_settings["movement_mult"],
        "jump_mult": admin_settings["jump_mult"],
        "game_mode": game_mode,
        "ctf": ctf_public_state() if game_mode == "ctf" else None,
    })

    # Notify others
    emit("player_joined", players[sid], broadcast=True, include_self=False)
    print(f"[+] {players[sid]['name']} connected ({sid})")

    # Update admin panels with new player list
    broadcast_admin_state()


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    if sid in players:
        print(f"[-] {players[sid]['name']} disconnected ({sid})")
        clean_ctf_state_for_player(sid)
        del players[sid]
        admin_sids.discard(sid)
        emit("player_left", {"id": sid}, broadcast=True)
        broadcast_admin_state()


@socketio.on("heartbeat")
def on_heartbeat(data):
    sid = request.sid
    if sid in players:
        players[sid]["last_seen_ts"] = time.time()


@socketio.on("set_name")
def on_set_name(data):
    sid = request.sid
    if sid in players:
        name = data.get("name", "").strip()[:20]
        if name:
            players[sid]["name"] = name
            emit("player_renamed", {"id": sid, "name": name}, broadcast=True)
            broadcast_admin_state()


@socketio.on("set_color")
def on_set_color(data):
    sid = request.sid
    if sid in players:
        color = data.get("color", "").strip()
        if color:
            players[sid]["color"] = color
            emit("player_recolored", {"id": sid, "color": color}, broadcast=True)


@socketio.on("player_update")
def on_player_update(data):
    sid = request.sid
    if sid in players:
        players[sid]["last_seen_ts"] = time.time()
        players[sid]["position"] = data.get("position", players[sid]["position"])
        players[sid]["rotation"] = data.get("rotation", players[sid]["rotation"])
        players[sid]["flashlight"] = data.get("flashlight", False)
        emit("player_moved", {
            "id": sid,
            "position": players[sid]["position"],
            "rotation": players[sid]["rotation"],
            "flashlight": players[sid]["flashlight"],
        }, broadcast=True, include_self=False)

        # Run CTF game logic when active
        if game_mode == "ctf" and ctf_state["phase"] == "playing":
            process_ctf_contacts(sid)


@socketio.on("stl_transform")
def on_stl_transform(data):
    sid = request.sid
    if not can_edit(sid):
        return
    model_id = data.get("id")
    if model_id in stl_models:
        if "position" in data:
            stl_models[model_id]["position"] = data["position"]
        if "rotation" in data:
            stl_models[model_id]["rotation"] = data["rotation"]
        if "scale" in data:
            stl_models[model_id]["scale"] = data["scale"]
        save_meta(stl_models[model_id])
        emit("stl_transformed", stl_models[model_id], broadcast=True, include_self=False)


@socketio.on("stl_delete")
def on_stl_delete(data):
    sid = request.sid
    if not can_edit(sid):
        return
    model_id = data.get("id")
    if model_id in stl_models:
        model = stl_models.pop(model_id)
        filepath = os.path.join(STL_DIR, model["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        mp = meta_path(model["filename"])
        if os.path.exists(mp):
            os.remove(mp)
        emit("stl_removed", {"id": model_id}, broadcast=True)
        broadcast_admin_state()


# --- Admin Events ---

@socketio.on("admin_login")
def on_admin_login(data):
    sid = request.sid
    password = data.get("password", "")
    if password == ADMIN_PASSWORD:
        admin_sids.add(sid)
        emit("admin_login_result", {"success": True})
        broadcast_admin_state(target_sid=sid)
        print(f"[ADMIN] {players.get(sid, {}).get('name', sid)} authenticated as admin")
    else:
        emit("admin_login_result", {"success": False})


@socketio.on("admin_delete_model")
def on_admin_delete_model(data):
    sid = request.sid
    if not is_admin(sid):
        return
    model_id = data.get("id")
    if model_id in stl_models:
        model = stl_models.pop(model_id)
        filepath = os.path.join(STL_DIR, model["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        mp = meta_path(model["filename"])
        if os.path.exists(mp):
            os.remove(mp)
        socketio.emit("stl_removed", {"id": model_id})
        broadcast_admin_state()


@socketio.on("admin_clear_scene")
def on_admin_clear_scene(data):
    """Delete all STLs and clear CTF map layout (flag homes + spawns)."""
    sid = request.sid
    if not is_admin(sid):
        return
    # Delete STL files and their metadata
    for model_id, model in list(stl_models.items()):
        filepath = os.path.join(STL_DIR, model["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        mp = meta_path(model["filename"])
        if os.path.exists(mp):
            os.remove(mp)
    stl_models.clear()

    # Clear CTF map layout
    ctf_state["flag_home"] = {"red": None, "blue": None}
    ctf_state["spawns"]    = {"red": None, "blue": None}
    ctf_state["flag_pos"]  = {"red": None, "blue": None}
    ctf_state["flag_holder"] = {"red": None, "blue": None}
    if os.path.exists(CTF_MAP_FILE):
        os.remove(CTF_MAP_FILE)

    # Broadcast refresh
    socketio.emit("scene_reloaded", {"models": []})
    broadcast_game_state()
    broadcast_admin_state()
    print(f"[ADMIN] Scene cleared")


@socketio.on("admin_toggle_editing")
def on_admin_toggle_editing(data):
    sid = request.sid
    if not is_admin(sid):
        return
    admin_settings["editing_enabled"] = bool(data.get("enabled", True))
    socketio.emit("editing_enabled_changed", {"enabled": admin_settings["editing_enabled"]})
    broadcast_admin_state()
    print(f"[ADMIN] Editing {'enabled' if admin_settings['editing_enabled'] else 'disabled'}")


@socketio.on("admin_toggle_upload")
def on_admin_toggle_upload(data):
    sid = request.sid
    if not is_admin(sid):
        return
    admin_settings["upload_enabled"] = bool(data.get("enabled", True))
    socketio.emit("upload_enabled_changed", {"enabled": admin_settings["upload_enabled"]})
    broadcast_admin_state()
    print(f"[ADMIN] Uploads {'enabled' if admin_settings['upload_enabled'] else 'disabled'}")


@socketio.on("admin_set_max_bbox")
def on_admin_set_max_bbox(data):
    sid = request.sid
    if not is_admin(sid):
        return
    try:
        admin_settings["max_bbox"] = max(0, float(data.get("value", 0)))
    except (TypeError, ValueError):
        admin_settings["max_bbox"] = 0
    broadcast_admin_state()
    print(f"[ADMIN] Max bbox set to {admin_settings['max_bbox']} (0=unlimited)")


@socketio.on("admin_teleport_all")
def on_admin_teleport_all(data):
    sid = request.sid
    if not is_admin(sid):
        return
    position = data.get("position", [0, 1.0, 0])
    socketio.emit("teleport", {"position": position})
    print(f"[ADMIN] Teleported all players to {position}")


@socketio.on("admin_set_lighting")
def on_admin_set_lighting(data):
    sid = request.sid
    if not is_admin(sid):
        return
    admin_settings["lighting"] = data
    socketio.emit("lighting_changed", data)


@socketio.on("admin_set_movement")
def on_admin_set_movement(data):
    sid = request.sid
    if not is_admin(sid):
        return
    try:
        admin_settings["movement_mult"] = max(0.1, min(10.0, float(data.get("movement_mult", 1.0))))
        admin_settings["jump_mult"]     = max(0.1, min(10.0, float(data.get("jump_mult", 1.0))))
    except (TypeError, ValueError):
        return
    socketio.emit("movement_changed", {
        "movement_mult": admin_settings["movement_mult"],
        "jump_mult": admin_settings["jump_mult"],
    })


# --- CTF Game Mode Events ---

@socketio.on("admin_set_mode")
def on_admin_set_mode(data):
    global game_mode
    sid = request.sid
    if not is_admin(sid):
        return
    new_mode = data.get("mode", "sandbox")
    if new_mode not in ("sandbox", "ctf"):
        return
    game_mode = new_mode
    if new_mode == "ctf":
        # Reset CTF state when entering mode
        ctf_state["phase"] = "pregame"
        ctf_state["teams"] = {}
        ctf_state["spawns"] = {"red": None, "blue": None}
        ctf_state["flag_home"] = {"red": None, "blue": None}
        ctf_state["flag_pos"] = {"red": None, "blue": None}
        ctf_state["flag_holder"] = {"red": None, "blue": None}
        ctf_state["scores"] = {"red": 0, "blue": 0}
    broadcast_game_state()
    broadcast_admin_state()
    print(f"[ADMIN] Game mode set to {new_mode}")


@socketio.on("admin_ctf_assign")
def on_admin_ctf_assign(data):
    """Set a single player's team: 'red', 'blue', or None (spectator)."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    target_sid = data.get("sid")
    team = data.get("team")  # "red", "blue", or None
    if target_sid not in players:
        return
    if team in ("red", "blue"):
        ctf_state["teams"][target_sid] = team
    elif team is None:
        ctf_state["teams"].pop(target_sid, None)
    broadcast_game_state()
    broadcast_admin_state()


@socketio.on("admin_ctf_randomize")
def on_admin_ctf_randomize(data):
    """Randomly split all non-admin players between red and blue (balanced).
    Admins are left alone - they can add themselves to a team manually if they want."""
    import random
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    # Exclude all admins from randomization
    sids = [psid for psid in players.keys() if not is_admin(psid)]
    random.shuffle(sids)
    # Split in half; if odd, red gets the extra
    split = (len(sids) + 1) // 2
    # Preserve existing admin team assignments
    new_teams = {psid: team for psid, team in ctf_state["teams"].items() if is_admin(psid)}
    for psid in sids[:split]:
        new_teams[psid] = "red"
    for psid in sids[split:]:
        new_teams[psid] = "blue"
    ctf_state["teams"] = new_teams
    broadcast_game_state()
    broadcast_admin_state()
    red_count = sum(1 for v in ctf_state["teams"].values() if v == "red")
    blue_count = sum(1 for v in ctf_state["teams"].values() if v == "blue")
    print(f"[ADMIN] CTF teams randomized: {red_count} red, {blue_count} blue ({len(sids)} non-admin players)")


@socketio.on("admin_ctf_assign_by_position")
def on_admin_ctf_assign_by_position(data):
    """Assign non-admin players to teams based on their current X position (X<0 blue, X>=0 red)."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    # Preserve existing admin team assignments
    new_teams = {psid: team for psid, team in ctf_state["teams"].items() if is_admin(psid)}
    for psid, p in players.items():
        if is_admin(psid):
            continue
        pos = p.get("position", [0, 0, 0])
        new_teams[psid] = "blue" if pos[0] < 0 else "red"
    ctf_state["teams"] = new_teams
    broadcast_game_state()
    broadcast_admin_state()
    red_count = sum(1 for v in ctf_state["teams"].values() if v == "red")
    blue_count = sum(1 for v in ctf_state["teams"].values() if v == "blue")
    print(f"[ADMIN] CTF teams assigned by position: {red_count} red, {blue_count} blue")


@socketio.on("admin_ctf_clear_teams")
def on_admin_ctf_clear_teams(data):
    """Clear all team assignments (everyone becomes spectator)."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    ctf_state["teams"] = {}
    broadcast_game_state()
    broadcast_admin_state()


def side_from_x(x):
    """Return 'blue' for X < 0, 'red' for X > 0."""
    return "blue" if x < 0 else "red"


CTF_CONTACT_DIST = 1.5         # avatars touching each other
CTF_FLAG_CONTACT_DIST = 1.5    # player touching a flag


def distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def clean_ctf_state_for_player(sid):
    """Remove a player from all CTF state: drop any held flag to home, clear team assignment.
    Call when a player disconnects or is evicted so we don't leave dangling references."""
    if game_mode != "ctf":
        return
    changed = False
    # Drop any flag the player was carrying back at home (they're gone, no meaningful drop location)
    for team in ("red", "blue"):
        if ctf_state["flag_holder"][team] == sid:
            ctf_state["flag_holder"][team] = None
            if ctf_state["flag_home"][team]:
                ctf_state["flag_pos"][team] = list(ctf_state["flag_home"][team])
            changed = True
    # Remove team assignment
    if sid in ctf_state["teams"]:
        del ctf_state["teams"][sid]
        changed = True
    if changed:
        broadcast_game_state()


def tag_player(sid):
    """Mark a player as tagged: drop any held flag at current position.
    Returns the spawn position (for the caller to emit teleport AFTER broadcasting
    updated game state) or None if the player has no valid team spawn.
    Does NOT emit teleport or player_tagged - the caller is responsible."""
    if sid not in players:
        return None
    # If carrying a flag, drop it at current position (ground level)
    for team in ("red", "blue"):
        if ctf_state["flag_holder"][team] == sid:
            pos = players[sid]["position"]
            # Flag drops at feet level; player position has EYE_HEIGHT offset from client
            ctf_state["flag_pos"][team] = [pos[0], max(0, pos[1] - 1.6), pos[2]]
            ctf_state["flag_holder"][team] = None
            socketio.emit("ctf_event", {"type": "flag_drop", "actor": sid, "team": team})
    team = ctf_state["teams"].get(sid)
    if team and ctf_state["spawns"].get(team):
        return list(ctf_state["spawns"][team])
    return None


def process_ctf_contacts(sid):
    """Run every time a player updates position during CTF. Detect tags and flag interactions."""
    if sid not in players:
        return
    my_team = ctf_state["teams"].get(sid)
    if my_team not in ("red", "blue"):
        return  # spectators don't interact

    my_pos = players[sid]["position"]
    enemy_team = "red" if my_team == "blue" else "blue"

    # My side: blue team's home is X < 0, red team's home is X > 0
    my_home_side_sign = -1 if my_team == "blue" else 1
    i_am_on_my_home = (my_pos[0] * my_home_side_sign) > 0

    # Use player's feet position for flag contact checks (my_pos is camera/eye level)
    EYE_HEIGHT = 1.6
    my_feet = [my_pos[0], my_pos[1] - EYE_HEIGHT, my_pos[2]]

    # Flag interactions -----
    # 1. Touch enemy flag (not held by anyone): pick it up
    enemy_flag_pos = ctf_state["flag_pos"][enemy_team]
    enemy_flag_holder = ctf_state["flag_holder"][enemy_team]
    if enemy_flag_pos and enemy_flag_holder is None:
        # Full 3D distance from feet to flag base
        if distance(my_feet, enemy_flag_pos) < CTF_FLAG_CONTACT_DIST:
            ctf_state["flag_holder"][enemy_team] = sid
            ctf_state["flag_pos"][enemy_team] = list(my_pos)
            socketio.emit("ctf_event", {"type": "flag_pickup", "actor": sid, "team": enemy_team})
            broadcast_game_state()

    # 2. Touch own flag (when it's not at home): return it
    own_flag_pos = ctf_state["flag_pos"][my_team]
    own_flag_holder = ctf_state["flag_holder"][my_team]
    own_flag_home = ctf_state["flag_home"][my_team]
    if own_flag_pos and own_flag_home and own_flag_holder is None:
        is_at_home = (distance(own_flag_pos, own_flag_home) < 0.1)
        if not is_at_home:
            if distance(my_feet, own_flag_pos) < CTF_FLAG_CONTACT_DIST:
                ctf_state["flag_pos"][my_team] = list(own_flag_home)
                socketio.emit("ctf_event", {"type": "flag_return", "actor": sid, "team": my_team})
                broadcast_game_state()

    # 3. Carrier touching own flag home: capture!
    carrying_enemy = (ctf_state["flag_holder"][enemy_team] == sid)
    if carrying_enemy and own_flag_home:
        if distance(my_feet, own_flag_home) < CTF_FLAG_CONTACT_DIST:
            ctf_state["scores"][my_team] += 1
            socketio.emit("ctf_event", {"type": "flag_capture", "actor": sid, "team": my_team})
            # Reset both flags to home
            for t in ("red", "blue"):
                if ctf_state["flag_home"][t]:
                    ctf_state["flag_pos"][t] = list(ctf_state["flag_home"][t])
                ctf_state["flag_holder"][t] = None
            broadcast_game_state()
            return  # no point checking contacts after capture

    # If carrier is moving, keep flag position synced to them
    for t in ("red", "blue"):
        if ctf_state["flag_holder"][t] == sid:
            ctf_state["flag_pos"][t] = list(my_pos)

    # Player-vs-player contacts - mutual annihilation:
    # when two opposing players collide, both go back to their spawns, unless
    # both are safely on their own home territory (no tag).
    tagged_anyone = False
    pending_teleports = []  # [(sid, spawn_pos), ...] - sent AFTER game_state broadcast
    for other_sid, other in list(players.items()):
        if other_sid == sid:
            continue
        other_team = ctf_state["teams"].get(other_sid)
        if other_team not in ("red", "blue") or other_team == my_team:
            continue  # teammates and spectators can't tag
        if distance(my_pos, other["position"]) > CTF_CONTACT_DIST:
            continue

        i_carry_enemy = (ctf_state["flag_holder"][enemy_team] == sid)
        they_carry_enemy = (ctf_state["flag_holder"][my_team] == other_sid)
        other_home_sign = -1 if other_team == "blue" else 1
        they_on_their_home = (other["position"][0] * other_home_sign) > 0

        # Safe pair: both are on their own home side AND neither carries the enemy flag
        any_flag = i_carry_enemy or they_carry_enemy
        if not any_flag and i_am_on_my_home and they_on_their_home:
            continue  # both in their own territory, no tag

        # Determine "tagger" vs "target" for the event log entry
        # (Mutual annihilation still, but one message per collision.)
        if i_carry_enemy and not they_carry_enemy:
            tagger, target = other_sid, sid
        elif they_carry_enemy and not i_carry_enemy:
            tagger, target = sid, other_sid
        elif i_am_on_my_home and not they_on_their_home:
            tagger, target = sid, other_sid
        elif they_on_their_home and not i_am_on_my_home:
            tagger, target = other_sid, sid
        else:
            # Both carrying flags, or both on enemy territory, or other edge case
            tagger, target = sid, other_sid

        spawn_a = tag_player(sid)
        spawn_b = tag_player(other_sid)
        if spawn_a: pending_teleports.append((sid, spawn_a))
        if spawn_b: pending_teleports.append((other_sid, spawn_b))
        socketio.emit("ctf_event", {"type": "player_tagged", "target": target, "actor": tagger})
        tagged_anyone = True
    if tagged_anyone:
        # Broadcast state FIRST so clients have flag_holder=null before they
        # teleport. Otherwise the carrier's client keeps syncing the flag to
        # its camera position between the teleport and the game_state event.
        broadcast_game_state()
        for psid, pos in pending_teleports:
            socketio.emit("teleport", {"position": pos}, to=psid)


@socketio.on("admin_ctf_place_flag")
def on_admin_ctf_place_flag(data):
    """Place the flag home for whichever side the admin is standing on."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    position = data.get("position")
    if not position or len(position) != 3:
        return
    side = side_from_x(position[0])
    ctf_state["flag_home"][side] = list(position)
    ctf_state["flag_pos"][side] = list(position)
    ctf_state["flag_holder"][side] = None
    save_ctf_map()
    broadcast_game_state()
    print(f"[ADMIN] Placed {side} flag at {position}")


@socketio.on("admin_ctf_place_spawn")
def on_admin_ctf_place_spawn(data):
    """Set the spawn position for whichever side the admin is standing on."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    position = data.get("position")
    if not position or len(position) != 3:
        return
    side = side_from_x(position[0])
    ctf_state["spawns"][side] = list(position)
    save_ctf_map()
    broadcast_game_state()
    print(f"[ADMIN] Placed {side} spawn at {position}")


@socketio.on("admin_ctf_start")
def on_admin_ctf_start(data):
    """Start the game: phase=playing, teleport all assigned players to spawn."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    # Require both spawns and both flags to be set
    if not all(ctf_state["spawns"][t] for t in ("red", "blue")):
        emit("admin_ctf_error", {"message": "Both spawns must be set before starting."})
        return
    if not all(ctf_state["flag_home"][t] for t in ("red", "blue")):
        emit("admin_ctf_error", {"message": "Both flags must be placed before starting."})
        return
    ctf_state["phase"] = "countdown"
    ctf_state["countdown_end_ts"] = time.time() + 5
    ctf_state["scores"] = {"red": 0, "blue": 0}
    # Reset flags to their home positions
    for t in ("red", "blue"):
        ctf_state["flag_pos"][t] = list(ctf_state["flag_home"][t])
        ctf_state["flag_holder"][t] = None
    # Teleport each assigned player to their team's spawn
    for psid, team in ctf_state["teams"].items():
        spawn = ctf_state["spawns"].get(team)
        if spawn:
            socketio.emit("teleport", {"position": list(spawn)}, to=psid)
    broadcast_game_state()
    print(f"[ADMIN] CTF countdown started")

    def transition_to_playing():
        # Wait 5 seconds (socketio.sleep yields to other tasks)
        socketio.sleep(5)
        # Only transition if we're still in countdown (admin may have stopped)
        if ctf_state["phase"] == "countdown":
            ctf_state["phase"] = "playing"
            broadcast_game_state()
            print(f"[ADMIN] CTF game now playing")

    socketio.start_background_task(transition_to_playing)


@socketio.on("admin_ctf_stop")
def on_admin_ctf_stop(data):
    """Stop the game: return to pregame."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    ctf_state["phase"] = "pregame"
    ctf_state["countdown_end_ts"] = None
    # Return flags to home
    for t in ("red", "blue"):
        if ctf_state["flag_home"][t]:
            ctf_state["flag_pos"][t] = list(ctf_state["flag_home"][t])
        ctf_state["flag_holder"][t] = None
    broadcast_game_state()
    print(f"[ADMIN] CTF game stopped")


STALE_PLAYER_TIMEOUT = 30   # seconds without heartbeat/update before eviction
CLEANUP_INTERVAL      = 10  # seconds between cleanup passes


def cleanup_stale_players():
    """Periodically remove players whose connections appear dead (no updates or
    heartbeats in STALE_PLAYER_TIMEOUT seconds). Belt-and-suspenders: Socket.IO's
    ping/pong should normally detect tab-close, but this catches stragglers."""
    while True:
        socketio.sleep(CLEANUP_INTERVAL)
        now = time.time()
        stale = [sid for sid, p in players.items()
                 if (now - p.get("last_seen_ts", now)) > STALE_PLAYER_TIMEOUT]
        for sid in stale:
            print(f"[-] {players[sid]['name']} evicted (stale for {now - players[sid]['last_seen_ts']:.0f}s)")
            clean_ctf_state_for_player(sid)
            del players[sid]
            admin_sids.discard(sid)
            socketio.emit("player_left", {"id": sid})
        if stale:
            broadcast_admin_state()


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    if len(sys.argv) > 2:
        ADMIN_PASSWORD = sys.argv[2]
    print(f"FreeLAD server starting on http://0.0.0.0:{port}")
    print(f"Admin password: {ADMIN_PASSWORD}")
    print(f"STL directory: {STL_DIR}")
    print(f"Pre-loaded {len(stl_models)} STL model(s)")
    socketio.start_background_task(cleanup_stale_players)
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
