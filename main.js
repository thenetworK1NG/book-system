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

function initViewer() {
	const container = document.getElementById('viewer');
	animButtonsContainer = document.getElementById('animButtons');
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0xf0f0f0);

	camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
	camera.position.set(0, 1, 3);

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setSize(container.clientWidth, container.clientHeight);
	container.appendChild(renderer.domElement);

	const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
	scene.add(ambientLight);
	const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
	directionalLight.position.set(5, 10, 7.5);
	scene.add(directionalLight);

	controls = new OrbitControls(camera, renderer.domElement);
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
	const loader = new GLTFLoader();
	const onLoad = (gltf) => {
		currentModel = gltf.scene;
		scene.add(currentModel);
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
				animationClips.forEach((clip, idx) => {
					const btn = document.createElement('button');
					btn.textContent = clip.name || `Animation ${idx+1}`;
					btn.style.display = 'block';
					btn.style.marginBottom = '5px';
					btn.onclick = () => {
						// Decide direction based on toggle state
						const reverse = nextReverseByClip.get(clip) === true;
						// Stop only actions that conflict on same node targets
						const targets = getClipTargetNodeNames(clip);
						stopConflictingActions(targets, [clip]);
						// Configure and play action with direction
						const action = mixer.clipAction(clip);
						action.enabled = true;
						action.setLoop(THREE.LoopOnce, 1);
						action.clampWhenFinished = true;
						if (reverse) {
							// Always seek to the end before reversing to handle clamped/running states
							action.time = clip.duration;
							action.paused = false;
							action.timeScale = -1;
							action.play();
						} else {
							// Always start from beginning for forward
							action.reset();
							action.timeScale = 1;
							action.play();
						}
						// Toggle for next click
						nextReverseByClip.set(clip, !reverse);
					};
					animButtonsContainer.appendChild(btn);
					// Initialize toggle state to forward first
					nextReverseByClip.set(clip, false);
				});
			}
		}
	};
	if (typeof urlOrBuffer === 'string') {
		loader.load(urlOrBuffer, onLoad);
	} else {
		loader.parse(urlOrBuffer, '', onLoad);
	}
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
	openFileBtn.onclick = () => fileInput.click();
	fileInput.onchange = e => {
		const file = e.target.files[0];
		if (file) {
			const reader = new FileReader();
			reader.onload = function(ev) {
				const arrayBuffer = ev.target.result;
				loadGLB(arrayBuffer);
			};
			reader.readAsArrayBuffer(file);
		}
	};
	playAnimBtn.onclick = () => {
		if (mixer && animationClips && animationClips.length > 0) {
			animationClips.forEach(clip => {
				const action = mixer.clipAction(clip);
				action.reset();
				action.play();
			});
		}
	};
	// Play latch + front_cover together, toggling forward/reverse on each click
	openBookBtn.onclick = () => {
		if (!mixer || !animationClips) return;
		const selectedClips = animationClips.filter(clip => clip.tracks.some(track => {
			const nodeName = track.name.split('.')[0];
			return nodeName === 'latch' || nodeName === 'front_cover';
		}));
		if (selectedClips.length === 0) {
			console.warn('No latch/front_cover animations found in clips');
			return;
		}
		const combinedTargets = new Set();
		selectedClips.forEach(c => getClipTargetNodeNames(c).forEach(n => combinedTargets.add(n)));
		// Only stop conflicting actions; keep other frozen poses intact
		stopConflictingActions(combinedTargets, selectedClips);
		const reverse = openBookReverseNext === true;
		selectedClips.forEach(clip => {
			const action = mixer.clipAction(clip);
			action.enabled = true;
			action.setLoop(THREE.LoopOnce, 1);
			action.clampWhenFinished = true;
			if (reverse) {
				action.time = clip.duration;
				action.paused = false;
				action.timeScale = -1;
				action.play();
			} else {
				action.reset();
				action.timeScale = 1;
				action.play();
			}
		});
		openBookReverseNext = !reverse;
	};
});



