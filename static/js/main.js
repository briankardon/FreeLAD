import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

// ============================================================
// Constants
// ============================================================
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.3;
const EYE_HEIGHT = 1.6;
const GRAVITY = 25;
const JUMP_SPEED = 8;
const WALK_SPEED = 5;
const SPRINT_SPEED = 10;
const FLY_SPEED = 8;
const FLY_SPRINT_SPEED = 16;
const NETWORK_UPDATE_RATE = 1 / 20; // 20 Hz
const GROUND_PLANE_SIZE = 10000;

const MAX_PITCH = Math.PI / 2 - 0.15; // ~81 deg, avoids gimbal lock zone
const TRANSLATE_STEP = 0.5;
const ROTATE_STEP = Math.PI / 12; // 15 degrees
const SCALE_STEP = 0.1;

// ============================================================
// State
// ============================================================
let camera, scene, renderer, controls;
let clock, raycaster, mouseRaycaster;
let ambientLight, dirLight, hemiLight;
let sandboxGround, ctfGroundBlue, ctfGroundRed;

// Game state
let gameMode = "sandbox";
let ctfState = null;
const ctfMarkers = {
    // per-team visual markers for flag and spawn
    red: { flag: null, flagHome: null, spawn: null },
    blue: { flag: null, flagHome: null, spawn: null },
};

// Camera rotation (tracked as plain numbers to avoid Euler extraction instability)
let cameraYaw = 0;
let cameraPitch = 0;

// Player state
const velocity = new THREE.Vector3();
let onGround = false;
let flyMode = false;
let clipMode = false;
let sprinting = false;
let flashlightOn = false;
let flashlight, flashlightTarget;
const moveState = { forward: false, backward: false, left: false, right: false, up: false, down: false };

// STL state
const stlMeshes = new Map(); // model_id -> THREE.Mesh
const stlLoader = new STLLoader();
let selectedModel = null;
let transformMode = null; // null, "translate", "rotate", "scale"

// Admin state
let isAdmin = false;
let editingEnabled = true;
let uploadEnabled = true;
let movementMult = 1.0;
let jumpMult = 1.0;

// Multiplayer state
let socket;
let myId = null;
const remotePlayers = new Map();
let networkTimer = 0;

// Collision objects list (STL meshes to collide with)
const collidables = [];

// ============================================================
// Initialization
// ============================================================
function init() {
    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    mouseRaycaster = new THREE.Raycaster();

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 200, 500);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, EYE_HEIGHT, 5);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // Lights
    ambientLight = new THREE.AmbientLight(0x606060, 0.75);
    scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(50, 100, 50);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.left = -100;
    dirLight.shadow.camera.right = 100;
    dirLight.shadow.camera.top = 100;
    dirLight.shadow.camera.bottom = -100;
    scene.add(dirLight);

    hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x362907, 0.3);
    scene.add(hemiLight);

    // Ground planes - sandbox has a single green plane; CTF has red/blue halves
    const groundGeo = new THREE.PlaneGeometry(GROUND_PLANE_SIZE, GROUND_PLANE_SIZE);
    sandboxGround = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.9 }));
    sandboxGround.rotation.x = -Math.PI / 2;
    sandboxGround.receiveShadow = true;
    scene.add(sandboxGround);

    // CTF halves (hidden in sandbox mode); each is a half-plane, positioned left/right of X=0
    const halfGeo = new THREE.PlaneGeometry(GROUND_PLANE_SIZE / 2, GROUND_PLANE_SIZE);
    ctfGroundBlue = new THREE.Mesh(halfGeo, new THREE.MeshStandardMaterial({ color: 0x2e5a8a, roughness: 0.9 }));
    ctfGroundBlue.rotation.x = -Math.PI / 2;
    ctfGroundBlue.position.x = -GROUND_PLANE_SIZE / 4;
    ctfGroundBlue.receiveShadow = true;
    ctfGroundBlue.visible = false;
    scene.add(ctfGroundBlue);

    ctfGroundRed = new THREE.Mesh(halfGeo, new THREE.MeshStandardMaterial({ color: 0x8a2e2e, roughness: 0.9 }));
    ctfGroundRed.rotation.x = -Math.PI / 2;
    ctfGroundRed.position.x = GROUND_PLANE_SIZE / 4;
    ctfGroundRed.receiveShadow = true;
    ctfGroundRed.visible = false;
    scene.add(ctfGroundRed);

    // Grid for orientation - raised slightly above ground to avoid z-fighting flicker
    const grid = new THREE.GridHelper(200, 200, 0x888888, 0x444444);
    grid.position.y = 0.05;
    scene.add(grid);

    // Player flashlight (headlamp) - attached to camera so it follows look direction
    flashlight = new THREE.SpotLight(0xffe0b0, 5, 50, Math.PI / 6, 0.4, 1);
    flashlight.visible = false;
    flashlightTarget = new THREE.Object3D();
    flashlightTarget.position.set(0, 0, -1);
    camera.add(flashlight);
    camera.add(flashlightTarget);
    flashlight.target = flashlightTarget;
    flashlight.position.set(0, 0, 0);
    scene.add(camera); // camera must be in scene graph for children to render

    // Pointer lock controls - used only for lock/unlock management, not rotation
    controls = new PointerLockControls(camera, document.body);
    controls.pointerSpeed = 0; // disable built-in rotation (we handle it ourselves)

    // Custom mouse handler: track yaw/pitch as plain floats, build quaternion fresh.
    // This avoids the quaternion→Euler→quaternion round-trip that causes gimbal lock.
    document.addEventListener("mousemove", (e) => {
        if (!controls.isLocked) return;
        cameraYaw   -= e.movementX * 0.002;
        cameraPitch -= e.movementY * 0.002;
        cameraPitch  = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, cameraPitch));
        camera.quaternion.setFromEuler(new THREE.Euler(cameraPitch, cameraYaw, 0, "YXZ"));
    });

    controls.addEventListener("lock", () => {
        document.getElementById("blocker").classList.add("hidden");
        document.getElementById("hud").classList.add("active");
    });

    controls.addEventListener("unlock", () => {
        document.getElementById("blocker").classList.remove("hidden");
        document.getElementById("hud").classList.remove("active");
    });

    // Restore saved name/color from localStorage
    const savedName = localStorage.getItem("freelad_name");
    const savedColor = localStorage.getItem("freelad_color");
    if (savedName) document.getElementById("player-name").value = savedName;
    if (savedColor) document.getElementById("player-color").value = savedColor;

    // Blocker click to enter world
    document.getElementById("blocker").addEventListener("click", (e) => {
        if (e.target.id === "player-name" || e.target.id === "player-color" || e.target.id === "upload-btn" || e.target.tagName === "INPUT") return;
        if (socket) {
            const name = document.getElementById("player-name").value.trim();
            const color = document.getElementById("player-color").value;
            if (name) {
                socket.emit("set_name", { name });
                localStorage.setItem("freelad_name", name);
            }
            socket.emit("set_color", { color });
            localStorage.setItem("freelad_color", color);
        }
        controls.lock();
    });

    // Events
    window.addEventListener("resize", onWindowResize);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousedown", onMouseDown);

    // When tab becomes visible again, force a render and send an update.
    // Browsers throttle rAF on background tabs, so state can lag behind socket events.
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            if (renderer && scene && camera) {
                try { renderer.render(scene, camera); } catch (e) {}
            }
            sendPlayerUpdate();
        }
    });

    // STL upload
    document.getElementById("stl-upload").addEventListener("change", onSTLUpload);

    // Admin UI
    initAdminUI();

    // Network
    initNetwork();

    // Start render loop
    animate();
}

// ============================================================
// Input Handling
// ============================================================
function onKeyDown(e) {
    if (!controls.isLocked) return;

    switch (e.code) {
        // --- Movement ---
        case "KeyW": moveState.forward = true; break;
        case "KeyS": moveState.backward = true; break;
        case "KeyA": moveState.left = true; break;
        case "KeyD": moveState.right = true; break;
        case "Space":
            if (flyMode) {
                moveState.up = true;
            } else if (onGround) {
                velocity.y = JUMP_SPEED * jumpMult;
                onGround = false;
            }
            break;
        case "ShiftLeft": case "ShiftRight":
            if (flyMode) moveState.down = true;
            else sprinting = true;
            break;

        // --- Mode toggles ---
        case "KeyF":
            if (!canUseFlyClip()) break;
            flyMode = !flyMode;
            updateModeIndicators();
            if (flyMode) velocity.y = 0;
            break;
        case "KeyC":
            if (!canUseFlyClip()) break;
            clipMode = !clipMode;
            updateModeIndicators();
            break;
        case "KeyL":
            flashlightOn = !flashlightOn;
            flashlight.visible = flashlightOn;
            updateModeIndicators();
            break;

        // --- Admin CTF placement keys (only active in CTF mode) ---
        case "Digit1":
            if (isAdmin && gameMode === "ctf") {
                const p = camera.position.clone();
                p.y -= EYE_HEIGHT;
                socket.emit("admin_ctf_place_flag", { position: [p.x, p.y, p.z] });
            }
            break;
        case "Digit2":
            if (isAdmin && gameMode === "ctf") {
                const p = camera.position.clone();
                // Offset slightly above feet so players spawn just above the surface
                // and don't fall through due to floating-point imprecision
                p.y -= EYE_HEIGHT - 0.2;
                socket.emit("admin_ctf_place_spawn", { position: [p.x, p.y, p.z] });
            }
            break;

        // --- Drop selected model to ground ---
        case "KeyQ":
            if (selectedModel && canEdit()) groundSelectedModel();
            break;

        // --- Object transform mode selection (toggle on/off, respects editing lock) ---
        case "KeyG":
            if (!canEdit()) break;
            setTransformMode(transformMode === "translate" ? null : "translate");
            break;
        case "KeyR":
            if (!canEdit()) break;
            setTransformMode(transformMode === "rotate" ? null : "rotate");
            break;
        case "KeyT":
            if (!canEdit()) break;
            setTransformMode(transformMode === "scale" ? null : "scale");
            break;

        // --- Object manipulation with arrow keys ---
        case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
        case "PageUp": case "PageDown":
            if (selectedModel && transformMode && canEdit()) {
                e.preventDefault();
                transformSelectedModel(e.code, e.shiftKey);
            }
            break;

        // --- Delete selected model ---
        case "Delete":
            if (!canEdit()) break;
            deleteSelectedModel();
            break;
    }
}

function onKeyUp(e) {
    switch (e.code) {
        case "KeyW": moveState.forward = false; break;
        case "KeyS": moveState.backward = false; break;
        case "KeyA": moveState.left = false; break;
        case "KeyD": moveState.right = false; break;
        case "Space": moveState.up = false; break;
        case "ShiftLeft": case "ShiftRight":
            sprinting = false;
            moveState.down = false;
            break;
    }
}

function onMouseDown(e) {
    if (!controls.isLocked || e.button !== 0) return;

    // Raycast from crosshair to pick STL models
    mouseRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = mouseRaycaster.intersectObjects(Array.from(stlMeshes.values()), true);

    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj.parent && !obj.userData.modelId) obj = obj.parent;
        if (obj.userData.modelId) selectModel(obj.userData.modelId);
    } else {
        deselectModel();
    }
}

// ============================================================
// Transform Mode & Keyboard Object Manipulation
// ============================================================
function setTransformMode(mode) {
    if (!selectedModel && mode) return; // need a selection first
    transformMode = mode;
    updateModeIndicators();
}

function transformSelectedModel(keyCode, fine) {
    const mesh = stlMeshes.get(selectedModel);
    if (!mesh) return;

    // Fine mode (shift held) uses 1/5 step
    const mult = fine ? 0.2 : 1.0;

    // Get camera-relative forward/right for intuitive translate directions
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const yaw = Math.atan2(camDir.x, camDir.z);
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    switch (transformMode) {
        case "translate": {
            const step = TRANSLATE_STEP * mult;
            switch (keyCode) {
                case "ArrowUp":    mesh.position.addScaledVector(forward, step); break;
                case "ArrowDown":  mesh.position.addScaledVector(forward, -step); break;
                case "ArrowRight": mesh.position.addScaledVector(right, step); break;
                case "ArrowLeft":  mesh.position.addScaledVector(right, -step); break;
                case "PageUp":     mesh.position.y += step; break;
                case "PageDown":   mesh.position.y -= step; break;
            }
            break;
        }
        case "rotate": {
            const step = ROTATE_STEP * mult;
            switch (keyCode) {
                case "ArrowLeft":  mesh.rotation.y += step; break;
                case "ArrowRight": mesh.rotation.y -= step; break;
                case "ArrowUp":    mesh.rotation.x += step; break;
                case "ArrowDown":  mesh.rotation.x -= step; break;
                case "PageUp":     mesh.rotation.z += step; break;
                case "PageDown":   mesh.rotation.z -= step; break;
            }
            break;
        }
        case "scale": {
            const step = SCALE_STEP * mult;
            switch (keyCode) {
                case "ArrowUp": case "PageUp":
                    mesh.scale.multiplyScalar(1 + step); break;
                case "ArrowDown": case "PageDown":
                    mesh.scale.multiplyScalar(1 / (1 + step)); break;
                case "ArrowRight":
                    mesh.scale.x *= (1 + step); break;
                case "ArrowLeft":
                    mesh.scale.x *= 1 / (1 + step); break;
            }
            break;
        }
    }

    broadcastSTLTransform(selectedModel);
}

function canEdit() {
    if (isAdmin) return true;
    // Non-admins can never edit during CTF
    if (gameMode === "ctf") return false;
    return editingEnabled;
}

/** Are we a CTF team player during a phase that restricts movement/mode? */
function isCTFPlayerImmobilized() {
    // Only locked during the 5-sec countdown, and only for non-admin team players
    if (isAdmin) return false;
    if (gameMode !== "ctf" || !ctfState) return false;
    if (ctfState.phase !== "countdown") return false;
    return ctfState.teams[myId] === "red" || ctfState.teams[myId] === "blue";
}

/** Are we permitted to use fly / clip modes right now? */
function canUseFlyClip() {
    if (isAdmin) return true;
    if (gameMode !== "ctf" || !ctfState) return true;
    // Team players can't fly/clip during countdown or playing
    const myTeam = ctfState.teams[myId];
    if (myTeam !== "red" && myTeam !== "blue") return true; // spectators always can
    return ctfState.phase !== "countdown" && ctfState.phase !== "playing";
}

function updateUploadVisibility(enabled) {
    const uploadArea = document.querySelector(".upload-area-menu");
    if (!uploadArea) return;
    if (isAdmin) {
        uploadArea.style.display = "";
    } else if (gameMode === "ctf") {
        uploadArea.style.display = "none";
    } else {
        uploadArea.style.display = enabled ? "" : "none";
    }
}

// ============================================================
// HUD Message System
// ============================================================
let _hudMessageTimer = null;

/**
 * Show a transient HUD message in the center of the screen.
 * @param {string} text - message to show
 * @param {object} opts
 * @param {number} [opts.duration] - ms to show; 0 = persistent until cleared
 * @param {string} [opts.variant] - "team-red", "team-blue", "warning", "success", or "" for default
 */
function showHudMessage(text, opts = {}) {
    const { duration = 2000, variant = "" } = opts;
    const el = document.getElementById("hud-message");
    el.textContent = text;
    el.className = variant;
    el.style.display = "";
    el.style.opacity = "1";
    if (_hudMessageTimer) clearTimeout(_hudMessageTimer);
    if (duration > 0) {
        _hudMessageTimer = setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => { el.style.display = "none"; }, 300);
        }, duration);
    }
}

function clearHudMessage() {
    const el = document.getElementById("hud-message");
    el.style.display = "none";
    if (_hudMessageTimer) { clearTimeout(_hudMessageTimer); _hudMessageTimer = null; }
}

/**
 * Append a short event notification to the upper-right log.
 * Entries fade out after ~10 seconds.
 * @param {string} text
 * @param {string} [variant] - "team-red", "team-blue", "warning", "success", "muted"
 */
const EVENT_LOG_MAX = 12;
function logEvent(text, variant = "") {
    const log = document.getElementById("event-log");
    const entry = document.createElement("div");
    entry.className = "event-log-entry" + (variant ? " " + variant : "");
    entry.textContent = text;
    log.appendChild(entry);
    // Keep the log capped
    while (log.children.length > EVENT_LOG_MAX) log.removeChild(log.firstChild);
    // Fade out after 9s, remove after the 1s transition finishes
    setTimeout(() => {
        entry.classList.add("fading");
        setTimeout(() => entry.remove(), 1100);
    }, 9000);
}

// Known player names keyed by socket id, for formatting event log lines.
const playerNames = new Map();
function nameFor(sid) {
    if (sid === myId) return "You";
    return playerNames.get(sid) || "Someone";
}

function updateTeamIndicator() {
    const el = document.getElementById("team-indicator");
    if (gameMode !== "ctf" || !ctfState) {
        el.style.display = "none";
        return;
    }
    const myTeam = ctfState.teams[myId];
    if (myTeam === "red") {
        el.textContent = "TEAM RED";
        el.className = "team-red";
    } else if (myTeam === "blue") {
        el.textContent = "TEAM BLUE";
        el.className = "team-blue";
    } else {
        el.textContent = "SPECTATOR";
        el.className = "team-spectator";
    }
    el.style.display = "";
}

function updateModeIndicators() {
    document.getElementById("fly-indicator").className = flyMode ? "mode-on" : "mode-off";
    document.getElementById("clip-indicator").className = clipMode ? "mode-on" : "mode-off";
    document.getElementById("light-indicator").className = flashlightOn ? "mode-on" : "mode-off";

    // Transform mode indicator
    const el = document.getElementById("transform-indicator");
    if (!canEdit()) {
        el.textContent = "LOCKED";
        el.className = "mode-off";
    } else if (selectedModel && transformMode) {
        el.textContent = transformMode.toUpperCase();
        el.className = "mode-on";
    } else {
        el.textContent = "---";
        el.className = "mode-off";
    }
}

// ============================================================
// Admin UI
// ============================================================
function initAdminUI() {
    document.getElementById("admin-login-btn").addEventListener("click", () => {
        const pw = document.getElementById("admin-password").value;
        if (pw && socket) socket.emit("admin_login", { password: pw });
    });
    document.getElementById("admin-password").addEventListener("keydown", (e) => {
        if (e.code === "Enter") document.getElementById("admin-login-btn").click();
    });

    document.getElementById("admin-editing-toggle").addEventListener("change", (e) => {
        socket.emit("admin_toggle_editing", { enabled: e.target.checked });
    });

    document.getElementById("admin-upload-toggle").addEventListener("change", (e) => {
        socket.emit("admin_toggle_upload", { enabled: e.target.checked });
    });

    document.getElementById("admin-max-bbox").addEventListener("change", (e) => {
        socket.emit("admin_set_max_bbox", { value: parseFloat(e.target.value) || 0 });
    });

    document.getElementById("admin-teleport-btn").addEventListener("click", () => {
        socket.emit("admin_teleport_all", { position: camera.position.toArray() });
    });

    document.getElementById("admin-save-scene-btn").addEventListener("click", () => {
        // Trigger browser download with admin token
        const url = `/admin/save_scene?token=${encodeURIComponent(myId)}`;
        const a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    document.getElementById("admin-load-scene-btn").addEventListener("click", () => {
        document.getElementById("admin-load-scene-input").click();
    });

    document.getElementById("admin-clear-scene-btn").addEventListener("click", () => {
        if (confirm("Clear the entire scene? This will delete all STL models AND clear CTF flag/spawn placements. This cannot be undone.")) {
            socket.emit("admin_clear_scene", {});
        }
    });

    document.getElementById("admin-load-scene-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!confirm(`Load scene "${file.name}"? This will REPLACE all current models.`)) {
            e.target.value = "";
            return;
        }
        const formData = new FormData();
        formData.append("file", file);
        formData.append("token", myId);
        try {
            const resp = await fetch("/admin/load_scene", { method: "POST", body: formData });
            const data = await resp.json();
            if (data.error) alert("Load failed: " + data.error);
        } catch (err) {
            alert("Load failed: " + err.message);
        }
        e.target.value = "";
    });

    // Lighting controls
    const lightInputs = [
        ["admin-ambient-intensity", "admin-ambient-color"],
        ["admin-dir-intensity", "admin-dir-color"],
        ["admin-hemi-intensity", "admin-hemi-color"],
    ];
    for (const [sliderId, colorId] of lightInputs) {
        for (const id of [sliderId, colorId]) {
            document.getElementById(id).addEventListener("input", () => broadcastLighting());
        }
    }

    // Movement / jump multiplier sliders
    const moveSlider = document.getElementById("admin-movement-mult");
    const jumpSlider = document.getElementById("admin-jump-mult");
    const sendMovement = () => {
        document.getElementById("admin-movement-val").textContent = parseFloat(moveSlider.value).toFixed(1) + "×";
        document.getElementById("admin-jump-val").textContent     = parseFloat(jumpSlider.value).toFixed(1) + "×";
        socket.emit("admin_set_movement", {
            movement_mult: parseFloat(moveSlider.value),
            jump_mult: parseFloat(jumpSlider.value),
        });
    };
    moveSlider.addEventListener("input", sendMovement);
    jumpSlider.addEventListener("input", sendMovement);

    // Game mode radios
    document.getElementById("admin-mode-sandbox").addEventListener("change", (e) => {
        if (e.target.checked) socket.emit("admin_set_mode", { mode: "sandbox" });
    });
    document.getElementById("admin-mode-ctf").addEventListener("change", (e) => {
        if (e.target.checked) socket.emit("admin_set_mode", { mode: "ctf" });
    });
    document.getElementById("admin-ctf-randomize-btn").addEventListener("click", () => {
        socket.emit("admin_ctf_randomize", {});
    });
    document.getElementById("admin-ctf-by-position-btn").addEventListener("click", () => {
        socket.emit("admin_ctf_assign_by_position", {});
    });
    document.getElementById("admin-ctf-clear-btn").addEventListener("click", () => {
        socket.emit("admin_ctf_clear_teams", {});
    });
    document.getElementById("admin-ctf-start-btn").addEventListener("click", () => {
        socket.emit("admin_ctf_start", {});
    });
    document.getElementById("admin-ctf-stop-btn").addEventListener("click", () => {
        socket.emit("admin_ctf_stop", {});
    });

    // Prevent blocker click-through on admin panel inputs
    document.getElementById("admin-panel").addEventListener("click", (e) => e.stopPropagation());
    document.getElementById("admin-login").addEventListener("click", (e) => e.stopPropagation());
}

function broadcastLighting() {
    if (!socket) return;
    socket.emit("admin_set_lighting", {
        ambient: { intensity: parseFloat(document.getElementById("admin-ambient-intensity").value), color: document.getElementById("admin-ambient-color").value },
        directional: { intensity: parseFloat(document.getElementById("admin-dir-intensity").value), color: document.getElementById("admin-dir-color").value },
        hemisphere: { intensity: parseFloat(document.getElementById("admin-hemi-intensity").value), color: document.getElementById("admin-hemi-color").value },
    });
}

let _prevCtfPhase = null;
let _prevCtfScores = null;
let _prevCtfTeams = null;

function applyGameState(mode, ctf) {
    const prevMode = gameMode;
    const prevPhase = _prevCtfPhase;
    const prevScores = _prevCtfScores;

    // Clear any STL selection when the mode changes (CTF disallows editing for
    // non-admins, and a stale highlighted model would be un-clearable)
    if (prevMode !== mode && selectedModel) {
        deselectModel();
    }

    const prevTeams = _prevCtfTeams;
    gameMode = mode;
    ctfState = ctf;
    _prevCtfPhase  = ctf ? ctf.phase : null;
    _prevCtfScores = ctf ? { ...ctf.scores } : null;
    _prevCtfTeams  = ctf ? { ...ctf.teams } : null;

    // Force off fly/clip when a non-admin team player enters a locked phase
    if (!canUseFlyClip() && (flyMode || clipMode)) {
        flyMode = false;
        clipMode = false;
        moveState.up = moveState.down = false;
        updateModeIndicators();
    }

    // HUD announcements tied to phase/score changes
    if (ctf) {
        // Phase transitions
        if (prevPhase !== ctf.phase) {
            if (ctf.phase === "countdown") {
                // countdown display handled per-frame
            } else if (ctf.phase === "playing") {
                showHudMessage("GO!", { duration: 1500, variant: "success" });
            } else if (ctf.phase === "pregame" && (prevPhase === "playing" || prevPhase === "countdown")) {
                showHudMessage("Game ended", { duration: 2500, variant: "warning" });
            }
        }
        // Score changes
        if (prevScores) {
            if (ctf.scores.red > prevScores.red) {
                showHudMessage("RED SCORES!", { duration: 3000, variant: "team-red" });
            }
            if (ctf.scores.blue > prevScores.blue) {
                showHudMessage("BLUE SCORES!", { duration: 3000, variant: "team-blue" });
            }
        }
        // Team changes - diff prev vs new
        if (prevTeams) {
            const allSids = new Set([...Object.keys(prevTeams), ...Object.keys(ctf.teams)]);
            for (const sid of allSids) {
                const was = prevTeams[sid];
                const now = ctf.teams[sid];
                if (was === now) continue;
                const who = nameFor(sid);
                if (!now) {
                    logEvent(`${who} → spectator`, "muted");
                } else {
                    logEvent(`${who} → ${now.toUpperCase()} team`, "team-" + now);
                }
            }
        }
    }

    const ctfActive = (mode === "ctf");
    sandboxGround.visible = !ctfActive;
    ctfGroundBlue.visible = ctfActive;
    ctfGroundRed.visible = ctfActive;
    // Update avatar colors (CTF overrides with team color)
    refreshAllRemoteColors();
    // Update CTF flag and spawn markers
    refreshCTFMarkers();
    // Sync admin panel radios
    const sandboxRadio = document.getElementById("admin-mode-sandbox");
    const ctfRadio = document.getElementById("admin-mode-ctf");
    if (sandboxRadio && ctfRadio) {
        sandboxRadio.checked = !ctfActive;
        ctfRadio.checked = ctfActive;
    }
    const teamRow = document.getElementById("admin-ctf-team-row");
    if (teamRow) teamRow.style.display = ctfActive ? "" : "none";
    const gameRow = document.getElementById("admin-ctf-game-row");
    if (gameRow) gameRow.style.display = ctfActive ? "" : "none";
    if (ctfActive) {
        const phaseEl = document.getElementById("admin-ctf-phase");
        if (phaseEl) phaseEl.textContent = `Phase: ${ctfState.phase}`;
    }

    // Scoreboard + team indicator
    const scoreboard = document.getElementById("scoreboard");
    const flagBanner = document.getElementById("flag-banner");
    if (ctfActive) {
        scoreboard.style.display = "";
        document.getElementById("score-blue").textContent = ctfState.scores.blue;
        document.getElementById("score-red").textContent = ctfState.scores.red;
        document.getElementById("scoreboard-phase").textContent = ctfState.phase.toUpperCase();
        // Show "YOU HAVE THE FLAG" banner when carrying the enemy flag
        const carrying = (ctfState.flag_holder.red === myId) || (ctfState.flag_holder.blue === myId);
        flagBanner.style.display = carrying ? "" : "none";
    } else {
        scoreboard.style.display = "none";
        flagBanner.style.display = "none";
        document.getElementById("countdown-display").style.display = "none";
    }
    updateTeamIndicator();

    // Disable Start button unless both flags and spawns are set
    const startBtn = document.getElementById("admin-ctf-start-btn");
    if (startBtn) {
        const haveFlags  = ctfActive && ctfState.flag_home.red && ctfState.flag_home.blue;
        const haveSpawns = ctfActive && ctfState.spawns.red && ctfState.spawns.blue;
        startBtn.disabled = !(haveFlags && haveSpawns);
        startBtn.title = startBtn.disabled
            ? "Set both flags (press 1) and both spawns (press 2) first"
            : "";
    }

    updateUploadVisibility(uploadEnabled);
    updateModeIndicators();
}

function buildFlagMesh(team) {
    // Simple flag: pole + triangular cloth
    const group = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.0, 8), poleMat);
    pole.position.y = 1.5;
    pole.castShadow = true;
    group.add(pole);

    const clothMat = new THREE.MeshStandardMaterial({
        color: teamColor(team),
        roughness: 0.7,
        side: THREE.DoubleSide,
    });
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), clothMat);
    cloth.position.set(0.5, 2.6, 0);
    cloth.castShadow = true;
    group.add(cloth);

    return group;
}

function buildFlagHomeMarker(team) {
    // Translucent ring/disk showing the flag's home position when flag is picked up
    const mat = new THREE.MeshBasicMaterial({
        color: teamColor(team),
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 32), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    return ring;
}

function buildSpawnMarker(team) {
    // Glowing ring + vertical beam to mark the spawn point
    const group = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({
        color: teamColor(team),
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.5, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);

    const beamMat = new THREE.MeshBasicMaterial({
        color: teamColor(team),
        transparent: true,
        opacity: 0.2,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 15, 16, 1, true), beamMat);
    beam.position.y = 7.5;
    group.add(beam);

    return group;
}

function disposeMarker(m) {
    if (!m) return;
    scene.remove(m);
    m.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
}

function refreshCTFMarkers() {
    const ctfActive = (gameMode === "ctf") && ctfState;
    for (const team of ["red", "blue"]) {
        const markers = ctfMarkers[team];
        // Flag marker
        const flagPos = ctfActive ? ctfState.flag_pos[team] : null;
        const flagHome = ctfActive ? ctfState.flag_home[team] : null;
        const isHeld = ctfActive && ctfState.flag_holder[team];

        if (flagPos) {
            // Keep the flag visible whether held or not - syncHeldFlags() repositions it when held
            if (!markers.flag) {
                markers.flag = buildFlagMesh(team);
                scene.add(markers.flag);
            }
            if (!isHeld) markers.flag.position.fromArray(flagPos);
        } else {
            disposeMarker(markers.flag);
            markers.flag = null;
        }

        // Flag home marker (shows when flag is elsewhere)
        if (flagHome && (isHeld || (flagPos && (flagPos[0] !== flagHome[0] || flagPos[1] !== flagHome[1] || flagPos[2] !== flagHome[2])))) {
            if (!markers.flagHome) {
                markers.flagHome = buildFlagHomeMarker(team);
                scene.add(markers.flagHome);
            }
            markers.flagHome.position.fromArray(flagHome);
            markers.flagHome.position.y += 0.02;
        } else {
            disposeMarker(markers.flagHome);
            markers.flagHome = null;
        }

        // Spawn marker
        const spawnPos = ctfActive ? ctfState.spawns[team] : null;
        if (spawnPos) {
            if (!markers.spawn) {
                markers.spawn = buildSpawnMarker(team);
                scene.add(markers.spawn);
            }
            markers.spawn.position.fromArray(spawnPos);
        } else {
            disposeMarker(markers.spawn);
            markers.spawn = null;
        }
    }
}

function teamColor(team) {
    if (team === "red") return "#e74c3c";
    if (team === "blue") return "#3498db";
    return null;
}

function applyRemoteDisplay(rp, playerId) {
    const team = (gameMode === "ctf" && ctfState) ? ctfState.teams[playerId] : null;
    const col = teamColor(team) || rp.originalColor;
    // Spectators in CTF mode are semi-transparent to distinguish from players
    const isSpectator = (gameMode === "ctf" && !team);
    const opacity = isSpectator ? 0.35 : 1.0;
    rp.group.children.forEach((child) => {
        if (child.isMesh && child.material && child.material.color && !child.material.color.equals(new THREE.Color(0xffffff))) {
            child.material.color.set(col);
            child.material.transparent = isSpectator;
            child.material.opacity = opacity;
            child.material.needsUpdate = true;
        }
    });
}

function refreshAllRemoteColors() {
    for (const [id, rp] of remotePlayers) {
        applyRemoteDisplay(rp, id);
    }
}

function applyMovementSettings(mv, jp) {
    movementMult = mv;
    jumpMult = jp;
    const moveSlider = document.getElementById("admin-movement-mult");
    const jumpSlider = document.getElementById("admin-jump-mult");
    const moveVal = document.getElementById("admin-movement-val");
    const jumpVal = document.getElementById("admin-jump-val");
    if (moveSlider) moveSlider.value = mv;
    if (jumpSlider) jumpSlider.value = jp;
    if (moveVal) moveVal.textContent = mv.toFixed(1) + "×";
    if (jumpVal) jumpVal.textContent = jp.toFixed(1) + "×";
}

function applyLighting(data) {
    if (data.ambient) {
        ambientLight.intensity = data.ambient.intensity;
        ambientLight.color.set(data.ambient.color);
    }
    if (data.directional) {
        dirLight.intensity = data.directional.intensity;
        dirLight.color.set(data.directional.color);
    }
    if (data.hemisphere) {
        hemiLight.intensity = data.hemisphere.intensity;
        hemiLight.color.set(data.hemisphere.color);
    }
    // Update admin sliders if present
    if (document.getElementById("admin-panel").classList.contains("hidden")) return;
    if (data.ambient) {
        document.getElementById("admin-ambient-intensity").value = data.ambient.intensity;
        document.getElementById("admin-ambient-color").value = data.ambient.color;
    }
    if (data.directional) {
        document.getElementById("admin-dir-intensity").value = data.directional.intensity;
        document.getElementById("admin-dir-color").value = data.directional.color;
    }
    if (data.hemisphere) {
        document.getElementById("admin-hemi-intensity").value = data.hemisphere.intensity;
        document.getElementById("admin-hemi-color").value = data.hemisphere.color;
    }
}

function updateAdminPanel(data) {
    // Update settings
    document.getElementById("admin-editing-toggle").checked = data.settings.editing_enabled;
    document.getElementById("admin-upload-toggle").checked = data.settings.upload_enabled;
    document.getElementById("admin-max-bbox").value = data.settings.max_bbox;

    // Update model list
    const modelList = document.getElementById("admin-model-list");
    modelList.innerHTML = "";
    for (const model of data.models) {
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = model.name;
        nameSpan.title = model.name;
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.style.maxWidth = "150px";
        nameSpan.style.direction = "rtl";
        nameSpan.style.textAlign = "left";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "model-color-input";
        colorInput.value = model.color || "#aaaacc";
        colorInput.title = "Change model color";
        colorInput.addEventListener("input", (e) => {
            e.stopPropagation();
            socket.emit("admin_set_model_color", { id: model.id, color: e.target.value });
        });
        colorInput.addEventListener("click", (e) => e.stopPropagation());

        const delBtn = document.createElement("button");
        delBtn.textContent = "Del";
        delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            socket.emit("admin_delete_model", { id: model.id });
        });

        li.appendChild(nameSpan);
        li.appendChild(colorInput);
        li.appendChild(delBtn);
        modelList.appendChild(li);
    }

    // Update player list
    const playerList = document.getElementById("admin-player-list");
    playerList.innerHTML = "";
    const ctfActive = (data.game_mode === "ctf");
    for (const player of data.players) {
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = player.name;
        li.appendChild(nameSpan);

        if (ctfActive) {
            // Team assignment buttons
            const btnGroup = document.createElement("span");
            btnGroup.className = "team-btn-group";
            for (const [label, team, teamClass] of [["R", "red", "team-red"], ["B", "blue", "team-blue"], ["S", null, "team-gray"]]) {
                const btn = document.createElement("button");
                btn.textContent = label;
                btn.className = "team-btn " + teamClass + (player.team === team ? " active" : "");
                btn.title = team ? `Assign to ${team}` : "Set as spectator";
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    socket.emit("admin_ctf_assign", { sid: player.id, team });
                });
                btnGroup.appendChild(btn);
            }
            li.appendChild(btnGroup);
        }
        playerList.appendChild(li);
    }
}

// ============================================================
// Player Physics & Movement
// ============================================================
function updatePlayer(delta) {
    if (!controls.isLocked) return;

    // Immobilize team players during CTF countdown
    if (isCTFPlayerImmobilized()) {
        velocity.set(0, 0, 0);
        // Still apply ground snap so players don't sink
        if (!flyMode) {
            const groundY = getGroundHeight(camera.position) + EYE_HEIGHT;
            if (camera.position.y <= groundY) {
                camera.position.y = groundY;
                onGround = true;
            }
        }
        return;
    }

    const baseSpeed = flyMode
        ? (sprinting ? FLY_SPRINT_SPEED : FLY_SPEED)
        : (sprinting ? SPRINT_SPEED : WALK_SPEED);
    const speed = baseSpeed * movementMult;

    const direction = new THREE.Vector3();
    if (moveState.forward) direction.z += 1;
    if (moveState.backward) direction.z -= 1;
    if (moveState.left) direction.x += 1;
    if (moveState.right) direction.x -= 1;
    direction.normalize();

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const yaw = Math.atan2(camDir.x, camDir.z);

    const moveDir = new THREE.Vector3();
    moveDir.x = direction.x * Math.cos(yaw) + direction.z * Math.sin(yaw);
    moveDir.z = -direction.x * Math.sin(yaw) + direction.z * Math.cos(yaw);

    if (flyMode) {
        if (moveState.up) moveDir.y += 1;
        if (moveState.down) moveDir.y -= 1;
        if (moveState.forward || moveState.backward) {
            // camDir.y > 0 when looking up, < 0 when looking down.
            // Forward should follow camera pitch so looking-and-pressing-W
            // actually moves toward where you're looking.
            if (moveState.forward)  moveDir.y += camDir.y;
            if (moveState.backward) moveDir.y -= camDir.y;
        }
        moveDir.normalize();
        velocity.set(moveDir.x * speed, moveDir.y * speed, moveDir.z * speed);
    } else {
        velocity.x = moveDir.x * speed;
        velocity.z = moveDir.z * speed;
        velocity.y -= GRAVITY * delta;
    }

    const displacement = velocity.clone().multiplyScalar(delta);
    const currentPos = camera.position.clone();
    const newPos = currentPos.clone().add(displacement);

    if (!clipMode && collidables.length > 0) {
        resolveCollisions(currentPos, newPos);
    }

    camera.position.copy(newPos);

    if (!flyMode) {
        const groundY = getGroundHeight(camera.position) + EYE_HEIGHT;
        if (camera.position.y <= groundY) {
            camera.position.y = groundY;
            velocity.y = 0;
            onGround = true;
        } else {
            onGround = false;
        }
    }

    const p = camera.position;
    document.getElementById("position-display").textContent =
        `X: ${p.x.toFixed(1)}  Y: ${(p.y - EYE_HEIGHT).toFixed(1)}  Z: ${p.z.toFixed(1)}`;
}

// ============================================================
// Collision Detection (raycasting)
// ============================================================
function getGroundHeight(position) {
    // Ray from well above the player straight down; large finite range so it reaches
    // ground from any reasonable altitude (and doesn't go negative if player dips below 0).
    const origin = new THREE.Vector3(position.x, position.y + 10, position.z);
    raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    raycaster.far = 1000;

    const hits = raycaster.intersectObjects(collidables, true);
    for (const hit of hits) {
        if (hit.point.y <= position.y) return hit.point.y;
    }
    return 0;
}

function resolveCollisions(currentPos, newPos) {
    const feetY = currentPos.y - EYE_HEIGHT + 0.1;
    const headY = currentPos.y - 0.1;

    const horizDisp = new THREE.Vector3(newPos.x - currentPos.x, 0, newPos.z - currentPos.z);
    const horizDist = horizDisp.length();

    if (horizDist > 0.001) {
        const horizDir = horizDisp.clone().normalize();
        const heights = [feetY + 0.2, feetY + PLAYER_HEIGHT * 0.5, headY];

        for (const h of heights) {
            raycaster.set(new THREE.Vector3(currentPos.x, h, currentPos.z), horizDir);
            raycaster.far = horizDist + PLAYER_RADIUS;

            const hits = raycaster.intersectObjects(collidables, true);
            if (hits.length > 0 && hits[0].distance < horizDist + PLAYER_RADIUS) {
                const blockDist = Math.max(0, hits[0].distance - PLAYER_RADIUS);
                const ratio = blockDist / horizDist;
                newPos.x = currentPos.x + horizDisp.x * ratio;
                newPos.z = currentPos.z + horizDisp.z * ratio;

                if (hits[0].face) {
                    const normal = hits[0].face.normal.clone()
                        .transformDirection(hits[0].object.matrixWorld);
                    normal.y = 0;
                    normal.normalize();
                    const remaining = horizDisp.clone().multiplyScalar(1 - ratio);
                    const slide = remaining.sub(normal.multiplyScalar(remaining.dot(normal)));
                    newPos.x += slide.x;
                    newPos.z += slide.z;
                }
                break;
            }
        }
    }

    if (newPos.y > currentPos.y) {
        raycaster.set(currentPos, new THREE.Vector3(0, 1, 0));
        raycaster.far = (newPos.y - currentPos.y) + 0.2;
        const hits = raycaster.intersectObjects(collidables, true);
        if (hits.length > 0 && hits[0].distance < (newPos.y - currentPos.y) + 0.2) {
            newPos.y = currentPos.y + hits[0].distance - 0.2;
            velocity.y = 0;
        }
    }
}

// ============================================================
// STL Management
// ============================================================
function loadSTLModel(modelInfo) {
    stlLoader.load(`/stl_files/${modelInfo.filename}`, (geometry) => {
        geometry.computeVertexNormals();
        // Always center the geometry so bbox center is at origin. Saved positions
        // (from autoLift or later transforms) are all relative to centered geometry.
        geometry.center();

        const material = new THREE.MeshStandardMaterial({
            color: modelInfo.color || "#aaaacc",
            roughness: 0.5,
            metalness: 0.3,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.modelId = modelInfo.id;
        mesh.userData.originalName = modelInfo.original_name || modelInfo.filename;

        mesh.position.fromArray(modelInfo.position);
        mesh.rotation.set(...modelInfo.rotation);
        mesh.scale.fromArray(modelInfo.scale);

        // On fresh import: center geometry so the model appears at the player,
        // then lift so the bottom sits at ground level
        if (modelInfo.autoLift) {
            // Geometry is already centered above. Apply FreeCAD Z-up → Y-up rotation.
            mesh.rotation.x = -Math.PI / 2;

            // Compute world-space bounding box (accounts for rotation and scale)
            mesh.updateMatrixWorld(true);
            let bb = new THREE.Box3().setFromObject(mesh);

            // Enforce max bounding box size if set
            const maxBbox = modelInfo.maxBbox || 0;
            if (maxBbox > 0) {
                const size = new THREE.Vector3();
                bb.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                if (maxDim > maxBbox) {
                    const clampFactor = maxBbox / maxDim;
                    mesh.scale.multiplyScalar(clampFactor);
                    mesh.updateMatrixWorld(true);
                    bb = new THREE.Box3().setFromObject(mesh);
                }
            }

            if (bb.min.y < 0) {
                mesh.position.y -= bb.min.y;
                bb.max.y -= bb.min.y;
                bb.min.y = 0;
            }
            // Place the uploading player on top of the model
            if (modelInfo.uploader === myId) {
                camera.position.y = bb.max.y + EYE_HEIGHT;
                velocity.y = 0;
                onGround = false;
            }
            // Broadcast the corrected position/scale back to the server
            broadcastSTLTransform(modelInfo.id);
        }

        scene.add(mesh);
        stlMeshes.set(modelInfo.id, mesh);
        collidables.push(mesh);
    });
}

function selectModel(modelId) {
    if (selectedModel && selectedModel !== modelId) {
        const prev = stlMeshes.get(selectedModel);
        if (prev) prev.material.emissive.setHex(0x000000);
    }

    const mesh = stlMeshes.get(modelId);
    if (!mesh) return;

    selectedModel = modelId;
    mesh.material.emissive.setHex(0x333344);
    updateModeIndicators();
}

function deselectModel() {
    if (selectedModel) {
        const mesh = stlMeshes.get(selectedModel);
        if (mesh) mesh.material.emissive.setHex(0x000000);
    }
    selectedModel = null;
    transformMode = null;
    updateModeIndicators();
}

function groundSelectedModel() {
    const mesh = stlMeshes.get(selectedModel);
    if (!mesh) return;
    // Compute world-space bounding box, then shift so its bottom is at Y=0
    const box = new THREE.Box3().setFromObject(mesh);
    mesh.position.y -= box.min.y;
    broadcastSTLTransform(selectedModel);
}

function deleteSelectedModel() {
    if (!selectedModel) return;
    const modelId = selectedModel;
    deselectModel();

    const mesh = stlMeshes.get(modelId);
    if (mesh) {
        scene.remove(mesh);
        stlMeshes.delete(modelId);
        const idx = collidables.indexOf(mesh);
        if (idx >= 0) collidables.splice(idx, 1);
        mesh.geometry.dispose();
        mesh.material.dispose();
    }

    socket.emit("stl_delete", { id: modelId });
}

function broadcastSTLTransform(modelId) {
    const mesh = stlMeshes.get(modelId);
    if (!mesh) return;
    socket.emit("stl_transform", {
        id: modelId,
        position: mesh.position.toArray(),
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        scale: mesh.scale.toArray(),
    });
}

async function onSTLUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Check for an existing model with the same original filename
    let replaceId = null;
    for (const mesh of stlMeshes.values()) {
        if (mesh.userData.originalName === file.name) {
            if (confirm(`A model named "${file.name}" already exists. Replace it? (Its position, rotation, scale, and color will be preserved.)\n\nClick Cancel to upload as a new model instead.`)) {
                replaceId = mesh.userData.modelId;
            }
            break;
        }
    }

    const scale = parseFloat(document.getElementById("import-scale").value) || 1;
    // Place the model at the player's feet position
    const pos = camera.position.clone();
    pos.y -= EYE_HEIGHT; // feet level, not eye level

    const formData = new FormData();
    formData.append("file", file);
    formData.append("scale", scale);
    formData.append("position", JSON.stringify([pos.x, pos.y, pos.z]));
    formData.append("uploader", myId);
    formData.append("color", document.getElementById("import-color").value);
    if (replaceId) formData.append("replace_id", replaceId);

    try {
        const resp = await fetch("/upload_stl", { method: "POST", body: formData });
        const data = await resp.json();
        if (data.error) console.error("Upload error:", data.error);
    } catch (err) {
        console.error("Upload failed:", err);
    }

    e.target.value = "";
}

// ============================================================
// Multiplayer Networking
// ============================================================
function initNetwork() {
    socket = io();

    // Heartbeat: lets the server know we're still alive even when our rAF
    // loop is throttled (backgrounded tab). Fires every 5 seconds.
    setInterval(() => {
        if (socket && socket.connected) socket.emit("heartbeat", {});
    }, 5000);

    socket.on("welcome", (data) => {
        myId = data.you.id;
        console.log("Connected as", data.you.name, "color:", data.you.color);
        playerNames.set(myId, data.you.name);

        // Apply saved name/color immediately on connect
        const savedName = localStorage.getItem("freelad_name");
        const savedColor = localStorage.getItem("freelad_color");
        if (savedName) {
            socket.emit("set_name", { name: savedName });
            playerNames.set(myId, savedName);
        }
        if (savedColor) socket.emit("set_color", { color: savedColor });

        // Sync the color picker to saved or server-assigned color
        document.getElementById("player-color").value = savedColor || data.you.color;

        for (const [sid, player] of Object.entries(data.players)) {
            addRemotePlayer(player);
            playerNames.set(sid, player.name);
        }
        for (const model of data.stl_models) {
            loadSTLModel(model);
        }
        editingEnabled = data.editing_enabled;
        uploadEnabled = data.upload_enabled;
        updateUploadVisibility(uploadEnabled);
        if (data.lighting) applyLighting(data.lighting);
        applyMovementSettings(data.movement_mult ?? 1.0, data.jump_mult ?? 1.0);
        applyGameState(data.game_mode || "sandbox", data.ctf || null);
        updateModeIndicators();
        updatePlayerCount();
    });

    socket.on("player_joined", (player) => {
        addRemotePlayer(player);
        playerNames.set(player.id, player.name);
        logEvent(`${player.name} joined`, "muted");
        updatePlayerCount();
    });

    socket.on("player_left", (data) => {
        const name = playerNames.get(data.id) || "Someone";
        logEvent(`${name} left`, "muted");
        playerNames.delete(data.id);
        removeRemotePlayer(data.id);
        updatePlayerCount();
    });

    socket.on("player_moved", (data) => {
        updateRemotePlayer(data);
    });

    socket.on("player_renamed", (data) => {
        playerNames.set(data.id, data.name);
        updateRemotePlayerName(data.id, data.name);
    });

    socket.on("player_recolored", (data) => {
        updateRemotePlayerColor(data.id, data.color);
    });

    socket.on("stl_added", (modelInfo) => {
        if (!stlMeshes.has(modelInfo.id)) loadSTLModel(modelInfo);
    });

    socket.on("stl_transformed", (modelInfo) => {
        const mesh = stlMeshes.get(modelInfo.id);
        if (mesh) {
            mesh.position.fromArray(modelInfo.position);
            mesh.rotation.set(...modelInfo.rotation);
            mesh.scale.fromArray(modelInfo.scale);
            if (modelInfo.color) mesh.material.color.set(modelInfo.color);
        }
    });

    socket.on("stl_file_replaced", (modelInfo) => {
        // Swap out geometry, keep transforms and color
        const mesh = stlMeshes.get(modelInfo.id);
        if (!mesh) return;
        stlLoader.load(`/stl_files/${modelInfo.filename}`, (geometry) => {
            geometry.computeVertexNormals();
            mesh.geometry.dispose();
            mesh.geometry = geometry;
            mesh.userData.originalName = modelInfo.original_name;
        });
    });

    socket.on("stl_removed", (data) => {
        const mesh = stlMeshes.get(data.id);
        if (mesh) {
            if (selectedModel === data.id) deselectModel();
            scene.remove(mesh);
            stlMeshes.delete(data.id);
            const idx = collidables.indexOf(mesh);
            if (idx >= 0) collidables.splice(idx, 1);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    });

    socket.on("scene_reloaded", (data) => {
        // Wipe all current STL meshes and load the new scene
        deselectModel();
        for (const [id, mesh] of stlMeshes) {
            scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        stlMeshes.clear();
        collidables.length = 0;
        for (const model of data.models) {
            loadSTLModel(model);
        }
    });

    // --- Admin events ---
    socket.on("admin_login_result", (data) => {
        if (data.success) {
            isAdmin = true;
            document.getElementById("admin-login").style.display = "none";
            document.getElementById("admin-panel").classList.remove("hidden");
            updateUploadVisibility(false); // re-evaluate with isAdmin=true
            updateModeIndicators();
        } else {
            document.getElementById("admin-password").style.borderColor = "#e74c3c";
            setTimeout(() => {
                document.getElementById("admin-password").style.borderColor = "#666";
            }, 1500);
        }
    });

    socket.on("admin_state", (data) => {
        updateAdminPanel(data);
    });

    socket.on("editing_enabled_changed", (data) => {
        editingEnabled = data.enabled;
        if (!canEdit()) {
            deselectModel();
            transformMode = null;
        }
        updateModeIndicators();
    });

    socket.on("upload_enabled_changed", (data) => {
        uploadEnabled = data.enabled;
        updateUploadVisibility(uploadEnabled);
    });

    socket.on("lighting_changed", (data) => {
        applyLighting(data);
    });

    socket.on("movement_changed", (data) => {
        applyMovementSettings(data.movement_mult, data.jump_mult);
    });

    socket.on("game_state", (data) => {
        applyGameState(data.mode || "sandbox", data.ctf || null);
    });

    socket.on("admin_ctf_error", (data) => {
        alert(data.message);
    });

    socket.on("ctf_event", (ev) => {
        const actor = nameFor(ev.actor);
        const target = nameFor(ev.target);
        const team = ev.team;
        switch (ev.type) {
            case "flag_pickup":
                logEvent(`${actor} picked up the ${team.toUpperCase()} flag`, "team-" + team);
                break;
            case "flag_drop":
                logEvent(`${actor} dropped the ${team.toUpperCase()} flag`, "team-" + team);
                break;
            case "flag_return":
                logEvent(`${actor} returned the ${team.toUpperCase()} flag`, "team-" + team);
                break;
            case "flag_capture":
                logEvent(`${actor} captured for ${team.toUpperCase()}!`, "success");
                break;
            case "player_tagged":
                logEvent(`${target} was tagged by ${actor}`, "warning");
                break;
        }
    });

    socket.on("teleport", (data) => {
        camera.position.fromArray(data.position);
        velocity.set(0, 0, 0);
        // Immediately notify server of new position so other clients see us there,
        // even if our rAF loop is throttled (backgrounded tab)
        sendPlayerUpdate();
        // Force one render so at least one frame is at the new position
        if (renderer && scene && camera) {
            try { renderer.render(scene, camera); } catch (e) {}
        }
    });
}

function sendPlayerUpdate() {
    if (!socket || !myId) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    socket.emit("player_update", {
        position: camera.position.toArray(),
        rotation: [dir.x, dir.y, dir.z],
        flashlight: flashlightOn,
    });
}

function updatePlayerCount() {
    document.getElementById("player-count").textContent = `Players: ${remotePlayers.size + 1}`;
}

// ============================================================
// Remote Player Avatars
// ============================================================
function addRemotePlayer(playerData) {
    if (remotePlayers.has(playerData.id)) return;

    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color: playerData.color });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.0, 8), bodyMat);
    body.position.y = 0.7;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), bodyMat.clone());
    head.position.y = 1.4;
    head.castShadow = true;
    group.add(head);

    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 4, 4), eyeMat);
    eyeL.position.set(-0.08, 1.45, -0.15);
    group.add(eyeL);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.06, 4, 4), eyeMat);
    eyeR.position.set(0.08, 1.45, -0.15);
    group.add(eyeR);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(playerData.name, 128, 42);
    const label = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true })
    );
    label.position.y = 2.0;
    label.scale.set(1.5, 0.375, 1);
    group.add(label);

    // Flashlight for remote player
    const rpLight = new THREE.SpotLight(0xffe0b0, 5, 50, Math.PI / 6, 0.4, 1);
    rpLight.position.set(0, 1.4, 0); // head level
    rpLight.visible = false;
    const rpLightTarget = new THREE.Object3D();
    rpLightTarget.position.set(0, 1.4, -5); // forward
    group.add(rpLight);
    group.add(rpLightTarget);
    rpLight.target = rpLightTarget;

    if (playerData.position) {
        group.position.fromArray(playerData.position);
        group.position.y -= EYE_HEIGHT;
    }

    scene.add(group);
    const rp = {
        group,
        light: rpLight,
        lightTarget: rpLightTarget,
        targetPos: group.position.clone(),
        targetDir: new THREE.Vector3(0, 0, -1),
        originalColor: playerData.color,
    };
    remotePlayers.set(playerData.id, rp);
    applyRemoteDisplay(rp, playerData.id);
}

function removeRemotePlayer(playerId) {
    const rp = remotePlayers.get(playerId);
    if (!rp) return;
    scene.remove(rp.group);
    rp.group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
        }
    });
    remotePlayers.delete(playerId);
}

function updateRemotePlayerName(playerId, name) {
    const rp = remotePlayers.get(playerId);
    if (!rp) return;
    rp.group.children.forEach((child) => {
        if (child.isSprite) {
            const canvas = child.material.map.image;
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, 256, 64);
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.fillRect(0, 0, 256, 64);
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 28px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(name, 128, 42);
            child.material.map.needsUpdate = true;
        }
    });
}

function updateRemotePlayerColor(playerId, color) {
    const rp = remotePlayers.get(playerId);
    if (!rp) return;
    rp.originalColor = color;
    applyRemoteDisplay(rp, playerId);
}

function updateRemotePlayer(data) {
    const rp = remotePlayers.get(data.id);
    if (!rp) return;
    rp.targetPos.fromArray(data.position);
    rp.targetPos.y -= EYE_HEIGHT;
    rp.targetDir.fromArray(data.rotation);
    // Update flashlight
    rp.light.visible = !!data.flashlight;
    if (data.flashlight) {
        // Group rotation handles yaw. Only need pitch for the local-space target.
        const dirY = data.rotation[1];
        const horizLen = Math.sqrt(data.rotation[0] ** 2 + data.rotation[2] ** 2);
        rp.lightTarget.position.set(0, 1.4 + dirY * 5, -horizLen * 5);
    }
}

function interpolateRemotePlayers(delta) {
    const t = Math.min(1, delta * 10);
    for (const [, rp] of remotePlayers) {
        rp.group.position.lerp(rp.targetPos, t);
        const yaw = Math.atan2(rp.targetDir.x, rp.targetDir.z);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI);
        rp.group.quaternion.slerp(q, t);
    }
}

// ============================================================
// Window Resize
// ============================================================
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================
// Main Loop
// ============================================================
function syncHeldFlags() {
    // Position flag meshes to their holder's current rendered position each frame
    if (gameMode !== "ctf" || !ctfState) return;
    for (const team of ["red", "blue"]) {
        const holder = ctfState.flag_holder[team];
        const flagMesh = ctfMarkers[team].flag;
        if (!holder) continue;
        // We need a flag mesh to show held flags; create if missing
        let mesh = flagMesh;
        if (!mesh) {
            mesh = buildFlagMesh(team);
            scene.add(mesh);
            ctfMarkers[team].flag = mesh;
        }
        if (holder === myId) {
            // Follow local camera: pole base at feet, so position is camera - EYE_HEIGHT
            mesh.position.set(camera.position.x, camera.position.y - EYE_HEIGHT, camera.position.z);
        } else {
            const rp = remotePlayers.get(holder);
            if (rp) mesh.position.copy(rp.group.position);
        }
    }
}

let _countdownLastShown = -1;

function updateCountdownDisplay() {
    const el = document.getElementById("countdown-display");
    if (gameMode !== "ctf" || !ctfState || ctfState.phase !== "countdown" || !ctfState.countdown_end_ts) {
        if (el.style.display !== "none") el.style.display = "none";
        _countdownLastShown = -1;
        return;
    }
    const remaining = Math.max(0, Math.ceil(ctfState.countdown_end_ts - Date.now() / 1000));
    if (remaining !== _countdownLastShown) {
        el.textContent = remaining > 0 ? remaining : "GO!";
        el.style.display = "";
        _countdownLastShown = remaining;
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.1);

    updatePlayer(delta);
    interpolateRemotePlayers(delta);
    updateCountdownDisplay();
    syncHeldFlags();

    networkTimer += delta;
    if (networkTimer >= NETWORK_UPDATE_RATE) {
        sendPlayerUpdate();
        networkTimer = 0;
    }

    renderer.render(scene, camera);
}

// ============================================================
// Start
// ============================================================
init();
