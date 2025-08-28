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
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0xf0f0f0);

	camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
	camera.position.set(-4.459, 0.474, 21.784);

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
	controls.target.set(-4.459, -0.269, -0.411);
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
	animate();
	loadGLB('book.glb');

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
		// On mobile, set exact default view
		if (isMobileDevice()) {
			camera.position.set(11.301, -0.011, 33.299);
			controls.target.set(17.293, -0.499, -1.535);
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

			// Generate buttons for each animation
			if (animButtonsContainer) {
				animButtonsContainer.innerHTML = '';
				// Create dropdown container
				const animGroup = document.createElement('details');
				animGroup.style.maxWidth = '220px';
				const animSummary = document.createElement('summary');
				animSummary.textContent = 'Model animations';
				animSummary.style.cursor = 'pointer';
				animGroup.appendChild(animSummary);
				// Rotation toggle inside dropdown
				const rotateWrap = document.createElement('label');
				rotateWrap.style.display = 'block';
				rotateWrap.style.margin = '6px 0 12px 0';
				rotateWrap.style.font = '12px sans-serif';
				const rotateToggle = document.createElement('input');
				rotateToggle.type = 'checkbox';
				rotateToggle.checked = controls ? !!controls.enableRotate : false;
				rotateWrap.appendChild(rotateToggle);
				rotateWrap.appendChild(document.createTextNode(' Enable rotation'));
				rotateToggle.addEventListener('change', () => {
					const enable = !!rotateToggle.checked;
					if (controls) {
						controls.enableRotate = enable;
						if (THREE.TOUCH) {
							controls.touches.ONE = enable ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
							controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
						}
					}
				});
				animGroup.appendChild(rotateWrap);
				// Front cover explicit open/close buttons (if clips exist)
				const frontClips = animationClips.filter(isFrontCoverClip);
				const latchClips = animationClips.filter(isLatchClip);
				if (frontClips.length > 0) {
					const btnOpenFront = document.createElement('button');
					btnOpenFront.textContent = 'Open front_cover';
					btnOpenFront.style.display = 'block';
					btnOpenFront.style.marginBottom = '5px';
					btnOpenFront.onclick = () => playFrontCoverDirection(1, frontClips, latchClips);
					animGroup.appendChild(btnOpenFront);
					const btnCloseFront = document.createElement('button');
					btnCloseFront.textContent = 'Close front_cover';
					btnCloseFront.style.display = 'block';
					btnCloseFront.style.marginBottom = '12px';
					btnCloseFront.onclick = () => playFrontCoverDirection(-1, frontClips, latchClips);
					animGroup.appendChild(btnCloseFront);
				}
				// Latch explicit open/close buttons (if clips exist)
				if (latchClips.length > 0) {
					const btnOpenLatch = document.createElement('button');
					btnOpenLatch.textContent = 'Open latch';
					btnOpenLatch.style.display = 'block';
					btnOpenLatch.style.marginBottom = '5px';
					btnOpenLatch.onclick = () => playLatchDirection(1, latchClips);
					animGroup.appendChild(btnOpenLatch);
					const btnCloseLatch = document.createElement('button');
					btnCloseLatch.textContent = 'Close latch';
					btnCloseLatch.style.display = 'block';
					btnCloseLatch.style.marginBottom = '12px';
					btnCloseLatch.onclick = () => playLatchDirection(-1, latchClips);
					animGroup.appendChild(btnCloseLatch);
				}

				// Only create page buttons for page1 and page2
				animationClips.forEach((clip) => {
					const isPage = isPageClip(clip);
					if (!isPage) return;
					const pageName = getPrimaryPageName(clip) || (clip.name || `page`);
					const pageIndex = extractPageIndex(pageName);
					if (pageIndex > 2) return; // restrict to page1 and page2 only
					// Open button (forward)
					const btnOpen = document.createElement('button');
					btnOpen.textContent = `Open ${pageName}`;
					btnOpen.style.display = 'block';
					btnOpen.style.marginBottom = '5px';
					btnOpen.onclick = () => playClipDirection(clip, 1, true);
					animGroup.appendChild(btnOpen);
					// Close button (reverse)
					const btnClose = document.createElement('button');
					btnClose.textContent = `Close ${pageName}`;
					btnClose.style.display = 'block';
					btnClose.style.marginBottom = '12px';
					btnClose.onclick = () => playClipDirection(clip, -1, true);
					animGroup.appendChild(btnClose);
					// Initialize page state as closed by default
					pageOpenByClip.set(clip, false);
					// Initialize toggle map though not used for explicit open/close
					nextReverseByClip.set(clip, false);
				});
				// Append dropdown to the buttons container
				animButtonsContainer.appendChild(animGroup);
			}
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
		// Enforce sequential opening: cannot open page N unless all previous pages are open
		if (direction > 0) {
			const ordered = getOrderedPageClips();
			const idx = ordered.indexOf(clip);
			if (idx > 0) {
				for (let i = 0; i < idx; i++) {
					if (pageOpenByClip.get(ordered[i]) !== true) {
						console.warn('Open previous pages first');
						return;
					}
				}
			}
		}
		// Enforce sequential closing: cannot close page N if any later page is open
		if (direction < 0) {
			const ordered = getOrderedPageClips();
			const idx = ordered.indexOf(clip);
			if (idx !== -1) {
				for (let i = idx + 1; i < ordered.length; i++) {
					if (pageOpenByClip.get(ordered[i]) === true) {
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
	// Ensure no handlers remain
	if (openFileBtn) openFileBtn.onclick = null;
	if (fileInput) fileInput.onchange = null;
	if (playAnimBtn) playAnimBtn.onclick = null;
	if (openBookBtn) openBookBtn.onclick = null;
});



