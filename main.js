// Smoothly open all previous pages in order until reaching the target page
function openPagesThen(targetClip, done) {
	const ordered = getOrderedPageClips();
	const idx = ordered.indexOf(targetClip);
	if (idx === -1) {
		done && done();
		return;
	}
	// Find all previous pages that are not open
	const toOpen = [];
	for (let i = 0; i < idx; i++) {
		if (pageOpenByClip.get(ordered[i]) !== true) {
			toOpen.push(ordered[i]);
		}
	}
	if (toOpen.length === 0) {
		done && done();
		return;
	}
	// Open pages one by one
	const [first, ...rest] = toOpen;
	// Stop conflicting actions for the page we are about to open
	const targets = getClipTargetNodeNames(first);
	stopConflictingActions(targets, [first]);
	const action = mixer.clipAction(first);
	action.enabled = true;
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.reset();
	action.timeScale = 1;
	action.play();
	playingDirectionByAction.set(action, 1);
	const handler = (e) => {
		if (e.action === action) {
			mixer.removeEventListener('finished', handler);
			if (rest.length > 0) {
				openPagesThen(targetClip, done);
			} else {
				done && done();
			}
		}
	};
	mixer.addEventListener('finished', handler);
}
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let scene, camera, renderer, controls, currentModel;
let mixer = null, animationClips = null;
let animButtonsContainer = null;
// Track per-clip toggle state: false -> forward next, true -> reverse next
const nextReverseByClip = new Map();
// Toggle for Open Book (latch + front_cover) sequence
let openBookReverseNext = false;
// Track per-page open state (true=open/end pose, false=closed/start pose)
const pageOpenByClip = new Map();
// Track direction of actions currently playing so we can update state on finish
const playingDirectionByAction = new Map();
// Track front cover state
let frontCoverOpen = false;
// Track latch state
let latchOpen = false;
// Keep references to lights for UI controls
let ambientLightRef = null;
let directionalLightRef = null;
let cameraInfoEl = null;
let lastCamHudUpdate = 0;
// Pan boundary settings (defaults enabled)
// Defaults per user: origin [-9.121, 0.358, -3.984], radius 10, enabled true
let panLimitEnabled = true;
let panLimitRadius = 10; // world units
let panOriginTarget = new THREE.Vector3(-9.121, 0.358, -3.984); // THREE.Vector3

function loadPanSettings() {
	// Intentionally disable persisted overrides; keep defaults requested by user
	return;
}

function savePanSettings() {
	// Persistence disabled per request to fix defaults; no-op
	return;
}

function isMobileDevice() {
	return (typeof window !== 'undefined') && (
		/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
		|| (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
	);
}

function fitCameraToObject(camera, controls, object3D, offset = 1.2) {
	// Compute bounding box of the object
	const box = new THREE.Box3().setFromObject(object3D);
	if (!box.isEmpty()) {
		const size = new THREE.Vector3();
		box.getSize(size);
		const center = new THREE.Vector3();
		box.getCenter(center);
		// Set controls target to center
		if (controls) controls.target.copy(center);
		// Compute distance needed to fit object in view based on fov and aspect
		const maxSize = Math.max(size.x, size.y, size.z);
		const fov = camera.fov * (Math.PI / 180);
		const aspect = camera.aspect;
		// Vertical fit distance
		const vDist = (maxSize / 2) / Math.tan(fov / 2);
		// Horizontal fit distance accounts for aspect
		const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
		const hDist = (maxSize / 2) / Math.tan(hFov / 2);
		const dist = Math.max(vDist, hDist) * offset;
		// Move camera along the vector from center toward current camera position
		const fromCenterDir = camera.position.clone().sub(center);
		if (fromCenterDir.lengthSq() < 1e-6) {
			// Degenerate: pick a sane default direction if camera is at center
			fromCenterDir.set(0, 0, 1);
		}
		fromCenterDir.normalize();
		camera.position.copy(center.clone().add(fromCenterDir.multiplyScalar(dist)));
		camera.updateProjectionMatrix();
		if (controls) controls.update();
	}
}

function initViewer() {
	const container = document.getElementById('viewer');
	animButtonsContainer = document.getElementById('animButtons');
	// Remove the menu per request: hide and null out the container so no UI is built
	if (animButtonsContainer) {
		animButtonsContainer.style.display = 'none';
		animButtonsContainer.innerHTML = '';
		animButtonsContainer = null;
	}
	cameraInfoEl = document.getElementById('cameraInfo');
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0xf0f0f0);

	camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
	if (isMobileDevice()) {
		// Mobile default view requested by user
		camera.position.set(0.848, 2.395, 37.029);
		// fov already 45; ensure projection updated
		camera.fov = 45;
		camera.updateProjectionMatrix();
	} else {
		camera.position.set(-4.459, 0.474, 21.784);
	}

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setSize(container.clientWidth, container.clientHeight);
	container.appendChild(renderer.domElement);

	const ambientLight = new THREE.AmbientLight(0xffffff, 2.0);
	scene.add(ambientLight);
	const directionalLight = new THREE.DirectionalLight(0xffffff, 2.0);
	directionalLight.position.set(5, 10, 7.5);
	scene.add(directionalLight);
	ambientLightRef = ambientLight;
	directionalLightRef = directionalLight;

	controls = new OrbitControls(camera, renderer.domElement);
	if (isMobileDevice()) {
		controls.target.set(-1.148, 0.010, -4.349);
	} else {
		controls.target.set(-4.459, -0.269, -0.411);
	}
	controls.enableRotate = false; // disable rotation; allow pan and zoom
	controls.enablePan = true;
	controls.enableZoom = true;
	// Make single-finger touch perform panning on touch devices
	if (THREE.TOUCH) {
		controls.touches = controls.touches || {};
		controls.touches.ONE = THREE.TOUCH.PAN;
		// Keep two-finger gesture for dolly (zoom)
		controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
	}
	// Mobile: set maximum zoom-in level (minDistance) to match requested view
	if (isMobileDevice()) {
		const maxInPos = new THREE.Vector3(-1.587, 1.381, 4.671);
		const maxInTarget = new THREE.Vector3(-2.023, 0.861, -4.356);
		controls.minDistance = maxInPos.distanceTo(maxInTarget);
		// Set maximum zoom-out distance from provided far view
		const maxOutPos = new THREE.Vector3(-6.756, 2.575, 34.772);
		const maxOutTarget = new THREE.Vector3(-8.627, 0.340, -4.007);
		controls.maxDistance = maxOutPos.distanceTo(maxOutTarget);
	}
	animate();
	loadGLB('book.glb');

	// Load persisted pan limit settings
	loadPanSettings();
	if (!panOriginTarget) {
		panOriginTarget = controls.target.clone();
	}

}

function loadGLB(urlOrBuffer) {
	if (currentModel) {
		scene.remove(currentModel);
		currentModel.traverse(child => {
			if (child.isMesh) child.geometry.dispose();
		});
		currentModel = null;
	}
	if (mixer) mixer = null;
	animationClips = null;
	if (animButtonsContainer) animButtonsContainer.innerHTML = '';
	nextReverseByClip.clear();
	openBookReverseNext = false;
	pageOpenByClip.clear();
	playingDirectionByAction.clear();
	frontCoverOpen = false;
	latchOpen = false;
	const loader = new GLTFLoader();
	const onLoad = (gltf) => {
		currentModel = gltf.scene;
		scene.add(currentModel);
		// On mobile, set exact default view (requested values)
		if (isMobileDevice()) {
			camera.position.set(0.848, 2.395, 37.029);
			controls.target.set(-1.148, 0.010, -4.349);
			camera.fov = 45;
			camera.updateProjectionMatrix();
			controls.update();
		}
		// Debug: log all object names in the loaded scene
		currentModel.traverse(obj => {
			if (obj.name) {
				console.log('Object name:', obj.name);
			}
			if (obj.name === 'front_cover' || obj.name === 'latch') {
				console.log('Found:', obj.name, 'Type:', obj.type, obj);
			}
		});
		// Build the AnimationMixer on the full glTF scene so track target names
		// (which are usually absolute or relative to the scene root) can be resolved.
		if (gltf.animations && gltf.animations.length > 0) {
			mixer = new THREE.AnimationMixer(currentModel);
			animationClips = gltf.animations;
			// Update per-page, front cover, and latch state when actions finish
			mixer.addEventListener('finished', (event) => {
				const action = event.action;
				if (!action) return;
				const clip = action.getClip ? action.getClip() : action._clip;
				const dir = playingDirectionByAction.get(action);
				playingDirectionByAction.delete(action);
				if (!clip || dir === undefined) return;
				if (isPageClip(clip)) {
					// dir > 0 => now open; dir < 0 => now closed
					pageOpenByClip.set(clip, dir > 0);
				}
				if (isFrontCoverClip(clip)) {
					frontCoverOpen = dir > 0;
				}
				if (isLatchClip(clip)) {
					latchOpen = dir > 0;
				}
			});

			// Debug: list clips and where each track is trying to bind
			console.group('GLTF Animation debug');
			animationClips.forEach((clip, cIdx) => {
				console.group(`Clip [${cIdx}]: ${clip.name || '(no name)'}`);
				clip.tracks.forEach(track => {
					const trackPath = track.name; // e.g. 'page1.position'
					const nodeName = trackPath.split('.')[0];
					const targetNode = currentModel.getObjectByName(nodeName);
					if (targetNode) {
						console.log(`Track: %c${trackPath}` , 'color:green', '-> Found node:', nodeName, targetNode);
					} else {
						console.warn(`Track: %c${trackPath}` , 'color:orange', '-> No node named', nodeName, 'under gltf.scene');
					}
				});
				console.groupEnd();
			});
			console.groupEnd();

			// Menu removed per request: do not create any animation or pan UI
			// Initialize page state map even without UI
			getOrderedPageClips().forEach((clip) => {
				pageOpenByClip.set(clip, false);
				nextReverseByClip.set(clip, false);
			});
		}
	};
	if (typeof urlOrBuffer === 'string') {
		loader.load(urlOrBuffer, onLoad);
	} else {
		loader.parse(urlOrBuffer, '', onLoad);
	}
}

function isPageClip(clip) {
	// A clip is considered a page clip if any of its track target node names contains 'page'
	return clip.tracks.some(track => {
		const nodeName = track.name.split('.')[0];
		return typeof nodeName === 'string' && nodeName.toLowerCase().includes('page');
	});
}

function isFrontCoverClip(clip) {
	return clip.tracks.some(track => {
		const nodeName = track.name.split('.')[0];
		return nodeName === 'front_cover';
	});
}

function isLatchClip(clip) {
	return clip.tracks.some(track => {
		const nodeName = track.name.split('.')[0];
		return nodeName === 'latch';
	});
}

function getPrimaryPageName(clip) {
	for (const track of clip.tracks) {
		const nodeName = track.name.split('.')[0];
		if (nodeName && nodeName.toLowerCase().includes('page')) return nodeName;
	}
	return null;
}

function extractPageIndex(name) {
	if (!name) return Number.MAX_SAFE_INTEGER;
	const match = name.match(/(\d+)/);
	return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function getOrderedPageClips() {
	if (!animationClips) return [];
	const pages = animationClips.filter(isPageClip).map(clip => {
		const name = getPrimaryPageName(clip) || clip.name || '';
		return { clip, name, index: extractPageIndex(name) };
	});
	pages.sort((a, b) => a.index - b.index);
	return pages.map(p => p.clip);
}

function playClipDirection(clip, direction, enforcePageState = false) {
	if (!mixer) return;
	// Enforce page open/close rules if requested
	if (enforcePageState && isPageClip(clip)) {
		const isOpen = pageOpenByClip.get(clip) === true;
		// Pages cannot turn if book is closed (latch must be open and front cover open)
		if (!frontCoverOpen || !latchOpen) {
			console.warn('Cannot turn pages while the book is closed');
			return;
		}
		// If opening a lower-index page while later pages are open, close later pages first
		if (direction > 0) {
			const ordered = getOrderedPageClips();
			let idx = ordered.indexOf(clip);
			if (idx > -1) {
				const laterOpen = [];
				for (let i = ordered.length - 1; i > idx; i--) {
					if (pageOpenByClip.get(ordered[i]) === true) laterOpen.push(ordered[i]);
				}
				if (laterOpen.length > 0) {
					// Close open later pages in descending order, then proceed to target
					closePagesThen(() => {
						// After closing later pages, ensure previous pages are open smoothly
						let needPrevOpen = false;
						for (let i = 0; i < idx; i++) {
							if (pageOpenByClip.get(ordered[i]) !== true) { needPrevOpen = true; break; }
						}
						if (needPrevOpen) {
							openPagesThen(clip, () => playClipDirection(clip, 1, true));
						} else {
							playClipDirection(clip, 1, true);
						}
					}, laterOpen);
					return;
				}
			}
			// Smoothly open all previous pages if needed
			const ordered2 = getOrderedPageClips();
			const idx2 = ordered2.indexOf(clip);
			if (idx2 > 0) {
				let needOpen = false;
				for (let i = 0; i < idx2; i++) {
					if (pageOpenByClip.get(ordered2[i]) !== true) {
						needOpen = true;
						break;
					}
				}
				if (needOpen) {
					openPagesThen(clip, () => playClipDirection(clip, direction, true));
					return;
				}
			}
		}
		// Enforce sequential closing: cannot close page N if any later page is open
		if (direction < 0) {
			const ordered3 = getOrderedPageClips();
			const idx3 = ordered3.indexOf(clip);
			if (idx3 !== -1) {
				for (let i = idx3 + 1; i < ordered3.length; i++) {
					if (pageOpenByClip.get(ordered3[i]) === true) {
						console.warn('Close later pages first');
						return;
					}
				}
			}
		}
		if (direction > 0 && isOpen) {
			// Already open: do nothing
			return;
		}
		if (direction < 0 && !isOpen) {
			// Already closed: do nothing
			return;
		}
	}
	// Stop only conflicting actions
	const targets = getClipTargetNodeNames(clip);
	stopConflictingActions(targets, [clip]);
	// Configure and play
	const action = mixer.clipAction(clip);
	action.enabled = true;
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	if (direction < 0) {
		action.time = clip.duration;
		action.paused = false;
		action.timeScale = -1;
		action.play();
		playingDirectionByAction.set(action, -1);
	} else {
		action.reset();
		action.timeScale = 1;
		action.play();
		playingDirectionByAction.set(action, 1);
	}
}

function playFrontCoverDirection(direction, frontClips, latchClips) {
	if (!mixer || !frontClips || frontClips.length === 0) return;
	if (direction > 0) {
		// Opening front cover requires latch to be open
		if (!latchOpen && latchClips && latchClips.length > 0) {
			const startedLatchActions = playLatchDirection(1, latchClips, /*returnActions*/ true) || [];
			if (startedLatchActions.length === 0) return;
			const remaining = new Set(startedLatchActions);
			const handler = (e) => {
				const a = e.action;
				if (remaining.has(a)) {
					remaining.delete(a);
					if (remaining.size === 0) {
						mixer.removeEventListener('finished', handler);
						// Now open front cover
						playFrontCoverDirection(1, frontClips, latchClips);
					}
				}
			};
			mixer.addEventListener('finished', handler);
			return;
		}
	} else {
		// Closing front cover: if any page is open, close all open pages in order first
		const orderedPages = getOrderedPageClips();
		const openPagesDesc = orderedPages
			.filter(clip => pageOpenByClip.get(clip) === true)
			.sort((a, b) => extractPageIndex(getPrimaryPageName(b) || b.name) - extractPageIndex(getPrimaryPageName(a) || a.name));
		if (openPagesDesc.length > 0) {
			closePagesThen(() => playFrontCoverDirection(-1, frontClips, latchClips), openPagesDesc);
			return;
		}
	}
	// Enforce front cover state
	if (direction > 0 && frontCoverOpen) return;
	if (direction < 0 && !frontCoverOpen) return;
	// Determine combined targets of front cover clips and stop only conflicts
	const combinedTargets = new Set();
	frontClips.forEach(c => getClipTargetNodeNames(c).forEach(n => combinedTargets.add(n)));
	stopConflictingActions(combinedTargets, frontClips);
	// Play all front cover clips in the requested direction
	const startedFrontActions = [];
	frontClips.forEach(clip => {
		const action = mixer.clipAction(clip);
		action.enabled = true;
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		if (direction < 0) {
			action.time = clip.duration;
			action.paused = false;
			action.timeScale = -1;
			action.play();
			playingDirectionByAction.set(action, -1);
			startedFrontActions.push(action);
		} else {
			action.reset();
			action.timeScale = 1;
			action.play();
			playingDirectionByAction.set(action, 1);
		}
	});

	// Play spline animation together with front cover
	if (animationClips) {
		// Find spline animation clips by name or by track targeting 'spline'
		const splineClips = animationClips.filter(clip => {
			if (clip.name && clip.name.toLowerCase().includes('spline')) return true;
			return clip.tracks.some(track => track.name.split('.')[0] === 'spline');
		});
		if (splineClips.length === 0) {
			console.warn('No spline animation clips found to play with front cover.');
		} else {
			console.log('Playing spline animation(s) with front cover:', splineClips.map(c => c.name));
		}
		splineClips.forEach(clip => {
			const action = mixer.clipAction(clip);
			action.enabled = true;
			action.setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
			if (direction < 0) {
				action.time = clip.duration;
				action.paused = false;
				action.timeScale = -1;
				action.play();
				playingDirectionByAction.set(action, -1);
			} else {
				action.reset();
				action.timeScale = 1;
				action.play();
				playingDirectionByAction.set(action, 1);
			}
		});
	}

	// If we are closing the front cover, then after it fully closes, also close the latch
	if (direction < 0 && latchClips && latchClips.length > 0 && startedFrontActions.length > 0) {
		const remainingFront = new Set(startedFrontActions);
		const onFrontClosed = (e) => {
			if (remainingFront.has(e.action)) {
				remainingFront.delete(e.action);
				if (remainingFront.size === 0) {
					mixer.removeEventListener('finished', onFrontClosed);
					// Front cover finished closing; now close the latch
					playLatchDirection(-1, latchClips);
				}
			}
		};
		mixer.addEventListener('finished', onFrontClosed);
	}
}

function closePagesThen(done, pagesToCloseDesc) {
	if (!pagesToCloseDesc || pagesToCloseDesc.length === 0) {
		done();
		return;
	}
	const [first, ...rest] = pagesToCloseDesc;
	const action = mixer.clipAction(first);
	action.enabled = true;
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.time = first.duration;
	action.paused = false;
	action.timeScale = -1;
	action.play();
	playingDirectionByAction.set(action, -1);
	const handler = (e) => {
		if (e.action === action) {
			mixer.removeEventListener('finished', handler);
			closePagesThen(done, rest);
		}
	};
	mixer.addEventListener('finished', handler);
}

function playLatchDirection(direction, latchClips, returnActions = false) {
	if (!mixer || !latchClips || latchClips.length === 0) return returnActions ? [] : undefined;
	// Enforce latch state + dependency: cannot close latch unless front cover is closed
	if (direction > 0 && latchOpen) return returnActions ? [] : undefined;
	if (direction < 0) {
		if (!latchOpen) return returnActions ? [] : undefined; // already closed
		if (frontCoverOpen) {
			console.warn('Cannot close latch while front cover is open');
			return returnActions ? [] : undefined;
		}
	}
	// Determine combined targets of latch clips and stop only conflicts
	const combinedTargets = new Set();
	latchClips.forEach(c => getClipTargetNodeNames(c).forEach(n => combinedTargets.add(n)));
	stopConflictingActions(combinedTargets, latchClips);
	// Play all latch clips in the requested direction
	const started = [];
	latchClips.forEach(clip => {
		const action = mixer.clipAction(clip);
		action.enabled = true;
		action.setLoop(THREE.LoopOnce, 1);
		action.clampWhenFinished = true;
		if (direction < 0) {
			action.time = clip.duration;
			action.paused = false;
			action.timeScale = -1;
			action.play();
			playingDirectionByAction.set(action, -1);
			started.push(action);
		} else {
			action.reset();
			action.timeScale = 1;
			action.play();
			playingDirectionByAction.set(action, 1);
			started.push(action);
		}
	});
	return returnActions ? started : undefined;
}

function getClipTargetNodeNames(clip) {
	const names = new Set();
	clip.tracks.forEach(track => {
		const nodeName = track.name.split('.')[0];
		if (nodeName) names.add(nodeName);
	});
	return names;
}

function setsIntersect(a, b) {
	for (const v of a) {
		if (b.has(v)) return true;
	}
	return false;
}

function stopConflictingActions(targetNodeNames, excludeClips = []) {
	if (!mixer || !animationClips) return;
	animationClips.forEach(c => {
		if (excludeClips.includes(c)) return;
		const names = getClipTargetNodeNames(c);
		if (setsIntersect(targetNodeNames, names)) {
			const a = mixer.existingAction(c);
			if (a) a.stop();
		}
	});
}

function animate() {
	requestAnimationFrame(animate);
	if (mixer) mixer.update(0.016); // ~60fps
	controls.update();
	// Enforce pan boundary (if enabled)
	if (panLimitEnabled && panLimitRadius > 0 && panOriginTarget) {
		const curT = controls.target;
		const delta = curT.clone().sub(panOriginTarget);
		const dist = delta.length();
		if (dist > panLimitRadius) {
			delta.setLength(panLimitRadius);
			const clampedTarget = panOriginTarget.clone().add(delta);
			const adjust = clampedTarget.clone().sub(curT);
			controls.target.copy(clampedTarget);
			camera.position.add(adjust);
		}
	}
	// Update camera HUD at ~10 fps to reduce cost
	if (cameraInfoEl) {
		const now = performance.now();
		if (now - lastCamHudUpdate > 100) {
			lastCamHudUpdate = now;
			const p = camera.position;
			const t = controls ? controls.target : new THREE.Vector3();
			const rot = camera.rotation;
			const fmt = (n)=> (Math.abs(n) < 1e-4 ? 0 : n).toFixed(3);
			cameraInfoEl.innerHTML = `
				<div class="row"><span class="label">pos</span><span>[${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}]</span></div>
				<div class="row"><span class="label">target</span><span>[${fmt(t.x)}, ${fmt(t.y)}, ${fmt(t.z)}]</span></div>
				<div class="row"><span class="label">rot</span><span>[${fmt(rot.x)}, ${fmt(rot.y)}, ${fmt(rot.z)}]</span></div>
				<div class="row"><span class="label">fov</span><span>${fmt(camera.fov)}</span></div>
				<div class="row"><span class="copy-hint">tap to copy</span></div>
			`;
		}
	}
	renderer.render(scene, camera);
}

window.addEventListener('DOMContentLoaded', () => {
	initViewer();
	const openFileBtn = document.getElementById('openFileBtn');
	const fileInput = document.getElementById('fileInput');
	const playAnimBtn = document.getElementById('playAnimBtn');
	const openBookBtn = document.getElementById('openBookBtn');
	// Hide and disable removed controls
	if (openFileBtn) openFileBtn.style.display = 'none';
	if (fileInput) fileInput.style.display = 'none';
	if (playAnimBtn) playAnimBtn.style.display = 'none';
	if (openBookBtn) openBookBtn.style.display = 'none';
	if (cameraInfoEl) {
		cameraInfoEl.addEventListener('click', () => {
			try {
				const txt = cameraInfoEl.textContent || '';
				navigator.clipboard && navigator.clipboard.writeText(txt);
			} catch (e) {}
		}, { passive: true });
	}
	// Ensure no handlers remain
	if (openFileBtn) openFileBtn.onclick = null;
	if (fileInput) fileInput.onchange = null;
	if (playAnimBtn) playAnimBtn.onclick = null;
	if (openBookBtn) openBookBtn.onclick = null;
});



