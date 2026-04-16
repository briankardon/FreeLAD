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
stl_models = {}  # model_id -> {id, filename, position, rotation, scale}

# Load existing STL files from disk on startup
def load_existing_stls():
    for filename in os.listdir(STL_DIR):
        if filename.lower().endswith(".stl"):
            model_id = str(uuid.uuid4())
            stl_models[model_id] = {
                "id": model_id,
                "filename": filename,
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
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


# --- HTTP Routes ---

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/stl_files/<path:filename>")
def serve_stl(filename):
    return send_from_directory(STL_DIR, filename)


@app.route("/upload_stl", methods=["POST"])
def upload_stl():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f = request.files["file"]
    if not f.filename.lower().endswith(".stl"):
        return jsonify({"error": "Only STL files are accepted"}), 400

    # Save with a safe unique name
    safe_name = f"{uuid.uuid4().hex}_{f.filename}"
    filepath = os.path.join(STL_DIR, safe_name)
    f.save(filepath)

    try:
        scale = float(request.form.get("scale", 1))
    except (TypeError, ValueError):
        scale = 1

    model_id = str(uuid.uuid4())
    stl_models[model_id] = {
        "id": model_id,
        "filename": safe_name,
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [scale, scale, scale],
    }

    # Broadcast new model to all clients
    socketio.emit("stl_added", stl_models[model_id])

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
    })

    # Notify others
    emit("player_joined", players[sid], broadcast=True, include_self=False)
    print(f"[+] {players[sid]['name']} connected ({sid})")


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    if sid in players:
        print(f"[-] {players[sid]['name']} disconnected ({sid})")
        del players[sid]
        emit("player_left", {"id": sid}, broadcast=True)


@socketio.on("set_name")
def on_set_name(data):
    sid = request.sid
    if sid in players:
        name = data.get("name", "").strip()[:20]
        if name:
            players[sid]["name"] = name
            emit("player_renamed", {"id": sid, "name": name}, broadcast=True)


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
        emit("player_moved", {
            "id": sid,
            "position": players[sid]["position"],
            "rotation": players[sid]["rotation"],
        }, broadcast=True, include_self=False)


@socketio.on("stl_transform")
def on_stl_transform(data):
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
    model_id = data.get("id")
    if model_id in stl_models:
        model = stl_models.pop(model_id)
        # Optionally delete the file
        filepath = os.path.join(STL_DIR, model["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
        emit("stl_removed", {"id": model_id}, broadcast=True)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    print(f"FreeLAD server starting on http://0.0.0.0:{port}")
    print(f"STL directory: {STL_DIR}")
    print(f"Pre-loaded {len(stl_models)} STL model(s)")
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
