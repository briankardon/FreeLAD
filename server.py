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

# Load existing STL files from disk on startup
def load_existing_stls():
    for filename in os.listdir(STL_DIR):
        if filename.lower().endswith(".stl"):
            model_id = str(uuid.uuid4())
            stl_models[model_id] = {
                "id": model_id,
                "filename": filename,
                "original_name": filename,
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "color": "#aaaacc",
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


def broadcast_admin_state(target_sid=None):
    """Send current admin settings and model list to an admin client."""
    data = {
        "settings": admin_settings,
        "models": [
            {"id": m["id"], "name": m["original_name"]}
            for m in stl_models.values()
        ],
        "players": [
            {"id": p["id"], "name": p["name"]}
            for p in players.values()
        ],
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
    # Enforce upload lock for non-admins
    uploader = request.form.get("uploader", "")
    if not admin_settings["upload_enabled"] and not is_admin(uploader):
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

    # Broadcast new model to all clients (autoLift tells clients to adjust Y)
    uploader = request.form.get("uploader", "")
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
    # Enforce editing lock for non-admins
    if not admin_settings["editing_enabled"] and not is_admin(sid):
        return
    model_id = data.get("id")
    if model_id in stl_models:
        if "position" in data:
            stl_models[model_id]["position"] = data["position"]
        if "rotation" in data:
            stl_models[model_id]["rotation"] = data["rotation"]
        if "scale" in data:
            stl_models[model_id]["scale"] = data["scale"]
        emit("stl_transformed", stl_models[model_id], broadcast=True, include_self=False)


@socketio.on("stl_delete")
def on_stl_delete(data):
    sid = request.sid
    # Enforce editing lock for non-admins
    if not admin_settings["editing_enabled"] and not is_admin(sid):
        return
    model_id = data.get("id")
    if model_id in stl_models:
        model = stl_models.pop(model_id)
        filepath = os.path.join(STL_DIR, model["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
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


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    ADMIN_PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "admin"
    print(f"FreeLAD server starting on http://0.0.0.0:{port}")
    print(f"Admin password: {ADMIN_PASSWORD}")
    print(f"STL directory: {STL_DIR}")
    print(f"Pre-loaded {len(stl_models)} STL model(s)")
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
