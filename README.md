# FreeLAD

**FreeLAD** (Free Lightweight Architectural Display) is a multiplayer 3D virtual world you run on your own computer. Your friends or classmates connect with a web browser and you can all walk around together inside a shared scene built from STL models that anyone in the room can upload.

It was built for a CAD class so students could explore each other's 3D models, but it also works great as a sandbox for collaborative scene-building or for the built-in **Capture the Flag** game mode (use student creations as obstacles, towers, and bases — it's a blast).

## What you can do with it

- Walk, run, jump, fly, and no-clip around a shared 3D world
- Upload STL files and place, rotate, scale, and color them
- See other players in real time with their names floating above them
- Carry a flashlight, toggle fly mode, and chase each other around
- Play **Capture the Flag** with auto team-balancing, scoring, and respawns
- Save the whole scene to a zip file and load it again later
- An admin panel for the host to control lighting, movement speed, who can edit, and the CTF game

---

## Quick start (Windows — easiest)

1. **Install Python 3.10 or newer** from <https://www.python.org/downloads/>.
   On the first installer screen, **check the box that says "Add Python to PATH"** before clicking Install.

2. **Download FreeLAD.** Either:
   - Click the green **Code** button on the GitHub page and choose **Download ZIP**, then unzip it somewhere (your Desktop is fine), **or**
   - If you have Git installed: `git clone <repo-url>` in a terminal.

3. **Double-click `setup.bat`** in the FreeLAD folder. This creates a Python virtual environment and installs the libraries FreeLAD needs. You only have to do this once.

4. **Double-click `run_server.bat`** to start the server. A black window will open and print something like:
   ```
   FreeLAD server starting on http://0.0.0.0:5000
   Admin password: admin
   ```
   Leave that window open for as long as you want the server running. Closing it stops the server.

5. **Open a browser** (Chrome or Edge work best) on the same computer and go to:
   ```
   http://localhost:5000
   ```

That's it — you're in the world.

## Quick start (Mac / Linux)

1. Install Python 3.10+ (`brew install python` on Mac, or your distro's package manager on Linux).
2. Download or clone the repo.
3. Open a terminal in the `FreeLAD` folder and run:
   ```bash
   ./setup.sh
   ./run_server.sh
   ```
4. Browse to <http://localhost:5000>.

---

## Letting other people connect

When the server starts, it prints the URL other people should use, like this:

```
============================================================
  FreeLAD server starting
============================================================
  On this computer:     http://localhost:5000
  Others on your Wi-Fi: http://192.168.1.42:5000
------------------------------------------------------------
```

Just give your friends the **"Others on your Wi-Fi"** URL.

If for some reason no LAN address gets detected, you can find it by hand:

- **Windows:** Open Command Prompt and type `ipconfig`. Look for the line that says **IPv4 Address** under your active network adapter (usually "Wireless LAN adapter Wi-Fi").
- **Mac:** Open Terminal and type `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`.
- **Linux:** Type `hostname -I` in a terminal. Make sure:

- They are on the **same network** as you (same Wi-Fi).
- The first time you run the server, **Windows Firewall** may pop up asking whether to allow Python to accept incoming connections. Click **Allow access** (Private networks is enough). If you missed the popup, you can re-enable it under *Windows Defender Firewall → Allow an app through firewall*.
- They use the **`http://`** prefix (not `https://`) and include the **`:5000`** port.

> **Note:** "Local network only" means home Wi-Fi or school Wi-Fi. Connecting friends across the internet requires extra setup (port forwarding, dynamic DNS, etc.) and is outside the scope of this guide.

---

## Manual setup (if you'd rather not use the scripts)

```bash
# 1. Create a virtual environment in a folder called "venv"
python -m venv venv

# 2. Activate it
#    Windows (cmd):
venv\Scripts\activate
#    Windows (PowerShell):
venv\Scripts\Activate.ps1
#    Mac / Linux:
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the server
python server.py
```

The server takes two optional arguments:

```bash
python server.py [port] [admin_password]
```

For example, `python server.py 8080 hunter2` runs on port 8080 with a custom admin password. The defaults are port `5000` and admin password `admin`.

You can also set the admin password with the `FREELAD_ADMIN_PASSWORD` environment variable.

---

## Using FreeLAD

When you load the page, you'll see a start menu where you can enter your name, pick an avatar color, and upload an STL. Click anywhere in the window to enter the world (this locks your mouse for first-person view — press **Esc** to release it).

### Controls

| Key | Action |
|---|---|
| **W A S D** | Move |
| **Space** | Jump (or fly up if flying) |
| **Shift** | Sprint (or fly down if flying) |
| **F** | Toggle fly mode |
| **C** | Toggle no-clip (walk through walls) |
| **L** | Toggle flashlight |
| **Mouse** | Look around |
| **Esc** | Release mouse |

### Editing models

| Key | Action |
|---|---|
| **Click an STL** | Select it |
| **G** / **R** / **T** | Switch to Translate / Rotate / Scale mode |
| **Arrow keys** | Move/rotate/scale on X-Z |
| **Page Up / Page Down** | Move/rotate/scale on Y |
| **Shift** | Fine adjustment |
| **Q** | Drop the selected model to the ground |
| **Delete** | Remove the selected model |

### Admin panel

In the start menu, type the admin password (default: `admin`) and click **Login**. You'll get an admin panel with controls for:

- **Allow editing / uploads:** lock down the world so only you can change it.
- **Max upload size:** cap how big student-uploaded STLs can be.
- **Teleport all here:** yank everyone to where you're standing.
- **Save / Load / Clear scene:** save the whole world (models, lighting, CTF map) to a `.zip` file and reload it later.
- **Lighting:** ambient, sun, and sky color & intensity sliders.
- **Movement:** scale walking speed and jump height for everyone.
- **Game mode:** switch between Sandbox and Capture the Flag.

### Capture the Flag

Switch to **Capture the Flag** mode in the admin panel. As an admin, walk to where you want the red base and press **1** (places a flag on whichever side of the world you're standing on). Press **2** to drop a spawn point. Repeat for the other team's side. Then:

1. Use **Randomize teams** or **Teams by position** to assign players to red and blue.
2. Click **Start game** — players are teleported to their spawns.
3. Touch the enemy flag to pick it up; bring it back to your own flag to score.
4. Touch an enemy on your side of the world to tag them (mutual annihilation — both respawn).

---

## Where your stuff is saved

- **Uploaded STL files** live in the `stl_files/` folder. They persist across server restarts.
- **Saved scenes** are zip files you choose where to put when you click *Save scene*.
- **Player names and colors** are stored in your browser's local storage.

To start completely fresh, click *Clear scene* in the admin panel (or just delete everything inside `stl_files/`).

---

## Troubleshooting

**"Python isn't recognized" when running `setup.bat`**
You forgot to check "Add Python to PATH" when installing Python. The easiest fix is to re-run the Python installer, click *Modify*, and tick that box. Then re-run `setup.bat`.

**"Port 5000 is already in use"**
Something else on your computer is using port 5000. Run the server on a different port:
- Edit `run_server.bat` and change `python server.py` to `python server.py 8080`.
- Tell people to connect to `http://...:8080` instead.

**Other people can't connect**
- Are they on the same Wi-Fi network?
- Did you allow Python through the Windows Firewall? (Re-running the server and clicking *Allow access* on the popup usually fixes it.)
- Did they include `http://` and `:5000` in the URL?
- Try `http://<your-ip>:5000` from your **own** computer first to confirm it's reachable.

**The browser shows a blank page or "can't connect"**
- Make sure the server window is still open and printing log lines.
- Try refreshing with **Ctrl+F5** to bypass the browser cache.

**Mouse won't lock / I can't look around**
- Click anywhere inside the 3D view first.
- Some browsers block pointer lock until you've interacted with the page.

**It's slow or laggy**
- Big STL files (tens of MB) eat browser memory. Decimate large meshes in your CAD tool before uploading.
- Try Chrome or Edge if you're on Firefox or Safari — performance varies.

---

## Credits & license

Built with [Flask-SocketIO](https://flask-socketio.readthedocs.io/) on the server and [Three.js](https://threejs.org/) in the browser.

Have fun, and feel free to break things!
