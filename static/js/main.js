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

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(GROUND_PLANE_SIZE, GROUND_PLANE_SIZE);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Grid for orientation
    const grid = new THREE.GridHelper(200, 200, 0x888888, 0x444444);
    grid.position.y = 0.01;
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
                velocity.y = JUMP_SPEED;
                onGround = false;
            }
            break;
        case "ShiftLeft": case "ShiftRight":
            sprinting = true; break;
        case "ControlLeft": case "ControlRight":
            if (flyMode) moveState.down = true;
            break;

        // --- Mode toggles ---
        case "KeyF":
            flyMode = !flyMode;
            updateModeIndicators();
            if (flyMode) velocity.y = 0;
            break;
        case "KeyC":
            clipMode = !clipMode;
            updateModeIndicators();
            break;
        case "KeyL":
            flashlightOn = !flashlightOn;
            flashlight.visible = flashlightOn;
            updateModeIndicators();
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
            sprinting = false; break;
        case "ControlLeft": case "ControlRight":
            moveState.down = false; break;
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
    return isAdmin || editingEnabled;
}

function updateUploadVisibility(enabled) {
    const uploadArea = document.querySelector(".upload-area-menu");
    if (uploadArea) {
        uploadArea.style.display = (isAdmin || enabled) ? "" : "none";
    }
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
        const delBtn = document.createElement("button");
        delBtn.textContent = "Del";
        delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            socket.emit("admin_delete_model", { id: model.id });
        });
        li.appendChild(nameSpan);
        li.appendChild(delBtn);
        modelList.appendChild(li);
    }

    // Update player list
    const playerList = document.getElementById("admin-player-list");
    playerList.innerHTML = "";
    for (const player of data.players) {
        const li = document.createElement("li");
        li.textContent = player.name;
        playerList.appendChild(li);
    }
}

// ============================================================
// Player Physics & Movement
// ============================================================
function updatePlayer(delta) {
    if (!controls.isLocked) return;

    const speed = flyMode
        ? (sprinting ? FLY_SPRINT_SPEED : FLY_SPEED)
        : (sprinting ? SPRINT_SPEED : WALK_SPEED);

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
            const pitch = -camDir.y;
            if (moveState.forward) moveDir.y += pitch;
            if (moveState.backward) moveDir.y -= pitch;
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
    const origin = new THREE.Vector3(position.x, position.y + 10, position.z);
    raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    raycaster.far = position.y + 20;

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

        const material = new THREE.MeshStandardMaterial({
            color: modelInfo.color || "#aaaacc",
            roughness: 0.5,
            metalness: 0.3,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.modelId = modelInfo.id;

        mesh.position.fromArray(modelInfo.position);
        mesh.rotation.set(...modelInfo.rotation);
        mesh.scale.fromArray(modelInfo.scale);

        // Auto-lift: shift up so the bounding box bottom sits at ground level
        if (modelInfo.autoLift) {
            geometry.computeBoundingBox();
            const bb = geometry.boundingBox.clone();
            bb.min.multiply(mesh.scale);
            bb.max.multiply(mesh.scale);

            // Enforce max bounding box size if set
            const maxBbox = modelInfo.maxBbox || 0;
            if (maxBbox > 0) {
                const size = new THREE.Vector3();
                bb.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                if (maxDim > maxBbox) {
                    const clampFactor = maxBbox / maxDim;
                    mesh.scale.multiplyScalar(clampFactor);
                    bb.min.multiplyScalar(clampFactor);
                    bb.max.multiplyScalar(clampFactor);
                }
            }

            if (bb.min.y < 0) {
                mesh.position.y -= bb.min.y;
            }
            // Place the uploading player on top of the model
            if (modelInfo.uploader === myId) {
                camera.position.y = mesh.position.y + bb.max.y + EYE_HEIGHT;
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
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox.clone();
    bb.min.multiply(mesh.scale);
    bb.max.multiply(mesh.scale);
    mesh.position.y = -bb.min.y;
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

    socket.on("welcome", (data) => {
        myId = data.you.id;
        console.log("Connected as", data.you.name, "color:", data.you.color);

        // Apply saved name/color immediately on connect
        const savedName = localStorage.getItem("freelad_name");
        const savedColor = localStorage.getItem("freelad_color");
        if (savedName) socket.emit("set_name", { name: savedName });
        if (savedColor) socket.emit("set_color", { color: savedColor });

        // Sync the color picker to saved or server-assigned color
        document.getElementById("player-color").value = savedColor || data.you.color;

        for (const [sid, player] of Object.entries(data.players)) {
            addRemotePlayer(player);
        }
        for (const model of data.stl_models) {
            loadSTLModel(model);
        }
        editingEnabled = data.editing_enabled;
        updateUploadVisibility(data.upload_enabled);
        if (data.lighting) applyLighting(data.lighting);
        updateModeIndicators();
        updatePlayerCount();
    });

    socket.on("player_joined", (player) => {
        addRemotePlayer(player);
        updatePlayerCount();
    });

    socket.on("player_left", (data) => {
        removeRemotePlayer(data.id);
        updatePlayerCount();
    });

    socket.on("player_moved", (data) => {
        updateRemotePlayer(data);
    });

    socket.on("player_renamed", (data) => {
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
        }
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
        updateUploadVisibility(data.enabled);
    });

    socket.on("lighting_changed", (data) => {
        applyLighting(data);
    });

    socket.on("teleport", (data) => {
        camera.position.fromArray(data.position);
        velocity.set(0, 0, 0);
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
    remotePlayers.set(playerData.id, {
        group,
        light: rpLight,
        lightTarget: rpLightTarget,
        targetPos: group.position.clone(),
        targetDir: new THREE.Vector3(0, 0, -1),
    });
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
    const c = new THREE.Color(color);
    rp.group.children.forEach((child) => {
        if (child.isMesh && child.material && !child.material.color.equals(new THREE.Color(0xffffff))) {
            child.material.color.copy(c);
        }
    });
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
function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.1);

    updatePlayer(delta);
    interpolateRemotePlayers(delta);

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
