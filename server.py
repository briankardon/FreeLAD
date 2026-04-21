"""
FreeLAD - Free Lightweight Architectural Display
A multiplayer 3D virtual world server for viewing and interacting with STL models.
"""

import os
import uuid
import json
from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = "freelad-dev"

socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=50 * 1024 * 1024)

STL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stl_files")
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
    with open(meta_path(model["filename"]), "w") as f:
        json.dump(data, f, indent=2)


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
    }

    # Send the new player their info and current world state
    emit("welcome", {
        "you": players[sid],
        "players": {k: v for k, v in players.items() if k != sid},
        "stl_models": list(stl_models.values()),
        "editing_enabled": admin_settings["editing_enabled"],
        "upload_enabled": admin_settings["upload_enabled"],
        "lighting": admin_settings.get("lighting"),
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
        del players[sid]
        admin_sids.discard(sid)
        emit("player_left", {"id": sid}, broadcast=True)
        broadcast_admin_state()


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
        players[sid]["position"] = data.get("position", players[sid]["position"])
        players[sid]["rotation"] = data.get("rotation", players[sid]["rotation"])
        players[sid]["flashlight"] = data.get("flashlight", False)
        emit("player_moved", {
            "id": sid,
            "position": players[sid]["position"],
            "rotation": players[sid]["rotation"],
            "flashlight": players[sid]["flashlight"],
        }, broadcast=True, include_self=False)


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
    """Randomly split all currently-connected players between red and blue."""
    import random
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    sids = list(players.keys())
    random.shuffle(sids)
    ctf_state["teams"] = {}
    for i, psid in enumerate(sids):
        ctf_state["teams"][psid] = "red" if i % 2 == 0 else "blue"
    broadcast_game_state()
    broadcast_admin_state()
    print(f"[ADMIN] CTF teams randomized")


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
    ctf_state["phase"] = "playing"
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
    print(f"[ADMIN] CTF game started")


@socketio.on("admin_ctf_stop")
def on_admin_ctf_stop(data):
    """Stop the game: return to pregame."""
    sid = request.sid
    if not is_admin(sid) or game_mode != "ctf":
        return
    ctf_state["phase"] = "pregame"
    # Return flags to home
    for t in ("red", "blue"):
        if ctf_state["flag_home"][t]:
            ctf_state["flag_pos"][t] = list(ctf_state["flag_home"][t])
        ctf_state["flag_holder"][t] = None
    broadcast_game_state()
    print(f"[ADMIN] CTF game stopped")


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    ADMIN_PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "admin"
    print(f"FreeLAD server starting on http://0.0.0.0:{port}")
    print(f"Admin password: {ADMIN_PASSWORD}")
    print(f"STL directory: {STL_DIR}")
    print(f"Pre-loaded {len(stl_models)} STL model(s)")
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
