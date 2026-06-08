<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		GraphConnectionRequest,
		GraphEdge,
		GraphNode,
		GraphNodePosition,
		GraphSocket,
		GraphSocketDirection,
		GraphSocketRef
	} from '../types';

	interface Camera {
		x: number;
		y: number;
		zoom: number;
	}

	interface PanGesture {
		pointerId: number;
		startX: number;
		startY: number;
		cameraX: number;
		cameraY: number;
	}

	interface NodeDragGesture {
		pointerId: number;
		nodeId: string;
		startX: number;
		startY: number;
		nodeX: number;
		nodeY: number;
	}

	interface ConnectionDraft {
		pointerId: number;
		from: GraphSocketRef;
		endX: number;
		endY: number;
	}

	let {
		nodes,
		edges,
		selectedNodeIds = [],
		onSelectionChange,
		onNodeMove,
		onConnect,
		emptyLabel = 'No nodes in this graph.'
	}: {
		nodes: GraphNode[];
		edges: GraphEdge[];
		selectedNodeIds?: string[];
		onSelectionChange?: (nodeIds: string[]) => void;
		onNodeMove?: (nodeId: string, position: GraphNodePosition) => void;
		onConnect?: (connection: GraphConnectionRequest) => void;
		emptyLabel?: string;
	} = $props();

	const MIN_ZOOM = 0.2;
	const MAX_ZOOM = 2.5;
	const DEFAULT_NODE_WIDTH_REM = 13;
	const NODE_HEADER_REM = 2.55;
	const SOCKET_ROW_REM = 1.45;
	const SOCKET_START_REM = 3.25;
	const FRAME_PADDING_REM = 3;
	const CAMERA_ANIMATION_MS = 240;

	let container: HTMLDivElement | null = $state(null);
	let camera = $state<Camera>({ x: 0, y: 0, zoom: 1 });
	let remPx = $state(16);
	let viewportWidth = $state(1);
	let viewportHeight = $state(1);
	let panGesture = $state<PanGesture | null>(null);
	let nodeDragGesture = $state<NodeDragGesture | null>(null);
	let connectionDraft = $state<ConnectionDraft | null>(null);
	let dragPositions = $state<Record<string, GraphNodePosition>>({});
	let animationFrame: number | null = null;

	let selectedIds = $derived(new Set(selectedNodeIds));
	let effectiveNodes = $derived(
		nodes.map((node) => {
			const dragged = dragPositions[node.id];
			return dragged ? { ...node, ...dragged } : node;
		})
	);
	let nodesById = $derived(new Map(effectiveNodes.map((node) => [node.id, node])));
	let gridSizePx = $derived(Math.max(4, remPx * camera.zoom));
	let transformStyle = $derived(`translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`);

	const clamp = (value: number, minimum: number, maximum: number): number =>
		Math.min(maximum, Math.max(minimum, value));

	const nodeWidth = (node: GraphNode): number => node.width ?? DEFAULT_NODE_WIDTH_REM;

	const nodeHeight = (node: GraphNode): number =>
		Math.max(
			NODE_HEADER_REM + 1.2,
			SOCKET_START_REM + Math.max(node.inputs.length, node.outputs.length, 1) * SOCKET_ROW_REM
		);

	const socketIndex = (
		node: GraphNode,
		socketId: string,
		direction: GraphSocketDirection
	): number => {
		const sockets = direction === 'input' ? node.inputs : node.outputs;
		return Math.max(
			0,
			sockets.findIndex((socket) => socket.id === socketId)
		);
	};

	const socketPoint = (
		reference: GraphSocketRef,
		direction: GraphSocketDirection
	): { x: number; y: number } | null => {
		const node = nodesById.get(reference.nodeId);
		if (!node) {
			return null;
		}
		return {
			x: (node.x + (direction === 'output' ? nodeWidth(node) : 0)) * remPx,
			y:
				(node.y +
					SOCKET_START_REM +
					(socketIndex(node, reference.socketId, direction) + 0.5) * SOCKET_ROW_REM) *
				remPx
		};
	};

	const wirePath = (start: { x: number; y: number }, end: { x: number; y: number }): string => {
		const horizontal = Math.abs(end.x - start.x);
		const control = clamp(horizontal * 0.5, remPx * 2.5, remPx * 12);
		return `M ${start.x} ${start.y} C ${start.x + control} ${start.y}, ${end.x - control} ${end.y}, ${end.x} ${end.y}`;
	};

	const edgePath = (edge: GraphEdge): string | null => {
		const start = socketPoint(edge.from, 'output');
		const end = socketPoint(edge.to, 'input');
		return start && end ? wirePath(start, end) : null;
	};

	const draftPath = (): string | null => {
		if (!connectionDraft) {
			return null;
		}
		const start = socketPoint(connectionDraft.from, 'output');
		return start ? wirePath(start, { x: connectionDraft.endX, y: connectionDraft.endY }) : null;
	};

	const clientToWorldPx = (clientX: number, clientY: number): { x: number; y: number } => {
		const bounds = container?.getBoundingClientRect();
		return {
			x: (clientX - (bounds?.left ?? 0) - camera.x) / camera.zoom,
			y: (clientY - (bounds?.top ?? 0) - camera.y) / camera.zoom
		};
	};

	const animateCamera = (target: Camera): void => {
		if (animationFrame !== null) {
			cancelAnimationFrame(animationFrame);
		}
		const source = { ...camera };
		const startedAt = performance.now();
		const tick = (now: number): void => {
			const progress = clamp((now - startedAt) / CAMERA_ANIMATION_MS, 0, 1);
			const eased = 1 - (1 - progress) ** 3;
			camera = {
				x: source.x + (target.x - source.x) * eased,
				y: source.y + (target.y - source.y) * eased,
				zoom: source.zoom + (target.zoom - source.zoom) * eased
			};
			if (progress < 1) {
				animationFrame = requestAnimationFrame(tick);
			} else {
				animationFrame = null;
			}
		};
		animationFrame = requestAnimationFrame(tick);
	};

	const frameNodes = (candidates: GraphNode[]): boolean => {
		if (!container || candidates.length === 0) {
			return false;
		}
		const left = Math.min(...candidates.map((node) => node.x));
		const top = Math.min(...candidates.map((node) => node.y));
		const right = Math.max(...candidates.map((node) => node.x + nodeWidth(node)));
		const bottom = Math.max(...candidates.map((node) => node.y + nodeHeight(node)));
		const widthPx = Math.max(remPx, (right - left) * remPx);
		const heightPx = Math.max(remPx, (bottom - top) * remPx);
		const paddingPx = FRAME_PADDING_REM * remPx;
		const zoom = clamp(
			Math.min(
				(viewportWidth - paddingPx * 2) / widthPx,
				(viewportHeight - paddingPx * 2) / heightPx
			),
			MIN_ZOOM,
			MAX_ZOOM
		);
		const centerX = (left + right) * 0.5 * remPx;
		const centerY = (top + bottom) * 0.5 * remPx;
		animateCamera({
			x: viewportWidth * 0.5 - centerX * zoom,
			y: viewportHeight * 0.5 - centerY * zoom,
			zoom
		});
		return true;
	};

	export const frameSelection = (): boolean => {
		const selected = effectiveNodes.filter((node) => selectedIds.has(node.id));
		return frameNodes(selected.length > 0 ? selected : effectiveNodes);
	};

	export const home = (): boolean => frameNodes(effectiveNodes);

	export const focus = (): void => {
		container?.focus();
	};

	const updateSelection = (nodeId: string, additive: boolean): void => {
		const next = additive ? new Set(selectedIds) : new Set<string>();
		if (additive && next.has(nodeId)) {
			next.delete(nodeId);
		} else {
			next.add(nodeId);
		}
		onSelectionChange?.([...next]);
	};

	const startPan = (event: PointerEvent): void => {
		if (event.button !== 0 && event.button !== 1) {
			return;
		}
		container?.focus();
		if (event.button === 0) {
			onSelectionChange?.([]);
		}
		panGesture = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			cameraX: camera.x,
			cameraY: camera.y
		};
		container?.setPointerCapture(event.pointerId);
	};

	const startNodeDrag = (event: PointerEvent, node: GraphNode): void => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		container?.focus();
		updateSelection(node.id, event.ctrlKey || event.metaKey || event.shiftKey);
		nodeDragGesture = {
			pointerId: event.pointerId,
			nodeId: node.id,
			startX: event.clientX,
			startY: event.clientY,
			nodeX: node.x,
			nodeY: node.y
		};
		container?.setPointerCapture(event.pointerId);
	};

	const startConnection = (event: PointerEvent, nodeId: string, socket: GraphSocket): void => {
		if (event.button !== 0 || socket.compatible === false) {
			return;
		}
		event.stopPropagation();
		const point = socketPoint({ nodeId, socketId: socket.id }, 'output');
		if (!point) {
			return;
		}
		connectionDraft = {
			pointerId: event.pointerId,
			from: { nodeId, socketId: socket.id },
			endX: point.x,
			endY: point.y
		};
		container?.setPointerCapture(event.pointerId);
	};

	const finishConnection = (event: PointerEvent, nodeId: string, socket: GraphSocket): void => {
		if (!connectionDraft || socket.compatible === false) {
			return;
		}
		event.stopPropagation();
		onConnect?.({
			from: connectionDraft.from,
			to: { nodeId, socketId: socket.id }
		});
		connectionDraft = null;
	};

	const handlePointerMove = (event: PointerEvent): void => {
		if (panGesture?.pointerId === event.pointerId) {
			camera = {
				...camera,
				x: panGesture.cameraX + event.clientX - panGesture.startX,
				y: panGesture.cameraY + event.clientY - panGesture.startY
			};
			return;
		}
		if (nodeDragGesture?.pointerId === event.pointerId) {
			dragPositions = {
				...dragPositions,
				[nodeDragGesture.nodeId]: {
					x: nodeDragGesture.nodeX + (event.clientX - nodeDragGesture.startX) / camera.zoom / remPx,
					y: nodeDragGesture.nodeY + (event.clientY - nodeDragGesture.startY) / camera.zoom / remPx
				}
			};
			return;
		}
		if (connectionDraft?.pointerId === event.pointerId) {
			const world = clientToWorldPx(event.clientX, event.clientY);
			connectionDraft = { ...connectionDraft, endX: world.x, endY: world.y };
		}
	};

	const handlePointerEnd = (event: PointerEvent): void => {
		if (panGesture?.pointerId === event.pointerId) {
			panGesture = null;
		}
		if (nodeDragGesture?.pointerId === event.pointerId) {
			const position = dragPositions[nodeDragGesture.nodeId];
			if (position) {
				onNodeMove?.(nodeDragGesture.nodeId, position);
				const { [nodeDragGesture.nodeId]: _, ...remaining } = dragPositions;
				dragPositions = remaining;
			}
			nodeDragGesture = null;
		}
		if (connectionDraft?.pointerId === event.pointerId) {
			connectionDraft = null;
		}
		if (container?.hasPointerCapture(event.pointerId)) {
			container.releasePointerCapture(event.pointerId);
		}
	};

	const handleWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const bounds = container?.getBoundingClientRect();
		if (!bounds) {
			return;
		}
		const pointerX = event.clientX - bounds.left;
		const pointerY = event.clientY - bounds.top;
		const worldX = (pointerX - camera.x) / camera.zoom;
		const worldY = (pointerY - camera.y) / camera.zoom;
		const zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.0014), MIN_ZOOM, MAX_ZOOM);
		camera = {
			x: pointerX - worldX * zoom,
			y: pointerY - worldY * zoom,
			zoom
		};
	};

	const handleKeydown = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		if (event.key.toLowerCase() === 'f') {
			event.preventDefault();
			event.stopPropagation();
			frameSelection();
		} else if (event.key.toLowerCase() === 'h') {
			event.preventDefault();
			event.stopPropagation();
			home();
		}
	};

	onMount(() => {
		if (!container) {
			return;
		}
		remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		const observer = new ResizeObserver(([entry]) => {
			viewportWidth = Math.max(1, entry.contentRect.width);
			viewportHeight = Math.max(1, entry.contentRect.height);
		});
		observer.observe(container);
		requestAnimationFrame(() => home());
		return () => {
			observer.disconnect();
			if (animationFrame !== null) {
				cancelAnimationFrame(animationFrame);
			}
		};
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={container}
	class:panning={panGesture !== null}
	class:connecting={connectionDraft !== null}
	class="graph-canvas"
	role="application"
	aria-label="Node graph"
	tabindex="0"
	style:--grid-size={`${gridSizePx}px`}
	onpointerdown={startPan}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerEnd}
	onpointercancel={handlePointerEnd}
	onkeydown={handleKeydown}
	onwheel={handleWheel}>
	<div class="toolbar">
		<button type="button" title="Frame selection (F)" onclick={frameSelection}>Frame</button>
		<button type="button" title="Home (H)" onclick={home}>Home</button>
		<output>{Math.round(camera.zoom * 100)}%</output>
	</div>

	<div class="world" style:transform={transformStyle}>
		<svg class="wires" aria-hidden="true">
			{#each edges as edge, index (`${edge.id ?? index}:${edge.from.nodeId}:${edge.to.nodeId}`)}
				{@const path = edgePath(edge)}
				{#if path}
					<path
						d={path}
						class:active={edge.active}
						class:invalid={edge.invalid}
						vector-effect="non-scaling-stroke" />
				{/if}
			{/each}
			{#if draftPath()}
				<path class="draft" d={draftPath() ?? ''} vector-effect="non-scaling-stroke" />
			{/if}
		</svg>

		{#each effectiveNodes as node (node.id)}
			<article
				class:selected={selectedIds.has(node.id)}
				class:active={node.active}
				class:invalid={node.invalid}
				class="node"
				style:left={`${node.x}rem`}
				style:top={`${node.y}rem`}
				style:width={`${nodeWidth(node)}rem`}>
				<button
					type="button"
					class="node-header"
					onpointerdown={(event) => startNodeDrag(event, node)}>
					<strong>{node.label}</strong>
					{#if node.subtitle}<small>{node.subtitle}</small>{/if}
				</button>
				<div class="socket-columns">
					<div class="socket-list inputs">
						{#each node.inputs as socket (socket.id)}
							<button
								type="button"
								class:incompatible={socket.compatible === false}
								class="socket input"
								title={socket.valueType ?? socket.label}
								onpointerup={(event) => finishConnection(event, node.id, socket)}>
								<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}></span>
								<span>{socket.label}</span>
							</button>
						{/each}
					</div>
					<div class="socket-list outputs">
						{#each node.outputs as socket (socket.id)}
							<button
								type="button"
								class:incompatible={socket.compatible === false}
								class="socket output"
								title={socket.valueType ?? socket.label}
								onpointerdown={(event) => startConnection(event, node.id, socket)}>
								<span>{socket.label}</span>
								<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}></span>
							</button>
						{/each}
					</div>
				</div>
			</article>
		{/each}
	</div>

	{#if nodes.length === 0}
		<p class="empty">{emptyLabel}</p>
	{/if}
</div>

<style>
	.graph-canvas {
		--ga-bg: var(--gc-color-background, #11151b);
		--ga-grid: color-mix(in srgb, var(--gc-color-text, #d8dfeb) 16%, transparent);
		--ga-node: color-mix(in srgb, var(--gc-color-background, #11151b) 80%, #293449);
		--ga-outline: var(--gc-color-panel-outline, #536077);
		--ga-selection: var(--gc-color-selection, #66a6ff);
		--ga-active: #63d69a;
		--ga-error: #ff6d75;
		--ga-socket: #b4c2d8;
		position: relative;
		inline-size: 100%;
		block-size: 100%;
		min-inline-size: 0;
		min-block-size: 0;
		overflow: hidden;
		outline: none;
		background-color: var(--ga-bg);
		background-image: radial-gradient(circle, var(--ga-grid) 0.065rem, transparent 0.075rem);
		background-position: var(--camera-x, 0) var(--camera-y, 0);
		background-size: var(--grid-size) var(--grid-size);
		user-select: none;
		cursor: grab;
	}

	.graph-canvas:focus-visible {
		box-shadow: inset 0 0 0 0.08rem color-mix(in srgb, var(--ga-selection) 70%, transparent);
	}

	.graph-canvas.panning,
	.graph-canvas.connecting {
		cursor: grabbing;
	}

	.world {
		position: absolute;
		inset: 0 auto auto 0;
		transform-origin: 0 0;
		will-change: transform;
	}

	.wires {
		position: absolute;
		inset: 0 auto auto 0;
		inline-size: 0.1rem;
		block-size: 0.1rem;
		overflow: visible;
		pointer-events: none;
	}

	.wires path {
		fill: none;
		stroke: color-mix(in srgb, var(--ga-socket) 72%, transparent);
		stroke-width: 0.16rem;
	}

	.wires path.active {
		stroke: var(--ga-active);
		filter: drop-shadow(0 0 0.22rem color-mix(in srgb, var(--ga-active) 65%, transparent));
	}

	.wires path.invalid {
		stroke: var(--ga-error);
		stroke-dasharray: 0.4rem 0.3rem;
	}

	.wires path.draft {
		stroke: var(--ga-selection);
		stroke-dasharray: 0.45rem 0.25rem;
	}

	.node {
		position: absolute;
		box-sizing: border-box;
		border: solid 0.08rem color-mix(in srgb, var(--ga-outline) 78%, transparent);
		border-radius: 0.55rem;
		background: var(--ga-node);
		box-shadow: 0 0.55rem 1.3rem rgb(0 0 0 / 0.28);
		color: var(--gc-color-text, #e8edf6);
		overflow: visible;
	}

	.node.selected {
		border-color: var(--ga-selection);
		box-shadow:
			0 0 0 0.08rem color-mix(in srgb, var(--ga-selection) 45%, transparent),
			0 0.6rem 1.4rem rgb(0 0 0 / 0.32);
	}

	.node.active {
		border-color: var(--ga-active);
	}

	.node.invalid {
		border-color: var(--ga-error);
	}

	.node-header {
		display: flex;
		flex-direction: column;
		inline-size: 100%;
		justify-content: center;
		min-block-size: 2.55rem;
		padding: 0.45rem 0.72rem;
		box-sizing: border-box;
		border: 0;
		border-block-end: solid 0.06rem color-mix(in srgb, var(--ga-outline) 55%, transparent);
		border-radius: 0.48rem 0.48rem 0 0;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--ga-selection) 18%, transparent),
			transparent
		);
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: grab;
	}

	.node-header:active {
		cursor: grabbing;
	}

	.node strong,
	.node small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node strong {
		font-size: 0.82rem;
	}

	.node small {
		font-size: 0.64rem;
		opacity: 0.62;
	}

	.socket-columns {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		min-block-size: 2.2rem;
		padding-block: 0.7rem;
	}

	.socket-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.socket {
		display: flex;
		align-items: center;
		gap: 0.42rem;
		block-size: 1.45rem;
		min-inline-size: 0;
		padding: 0 0.52rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.68rem;
		cursor: crosshair;
	}

	.socket.output {
		justify-content: flex-end;
		text-align: end;
	}

	.socket span:not(.pin) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.socket.incompatible {
		opacity: 0.34;
		cursor: not-allowed;
	}

	.pin {
		display: block;
		flex: 0 0 auto;
		inline-size: 0.68rem;
		block-size: 0.68rem;
		border: solid 0.11rem var(--socket-color);
		border-radius: 50%;
		background: var(--ga-node);
		box-shadow: 0 0 0 0.08rem rgb(0 0 0 / 0.32);
	}

	.input .pin {
		margin-inline-start: -0.94rem;
	}

	.output .pin {
		margin-inline-end: -0.94rem;
	}

	.socket:hover .pin {
		background: var(--socket-color);
	}

	.toolbar {
		position: absolute;
		inset-block-start: 0.7rem;
		inset-inline-end: 0.7rem;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.28rem;
		border: solid 0.06rem color-mix(in srgb, var(--ga-outline) 55%, transparent);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--ga-bg) 84%, transparent);
		backdrop-filter: blur(0.5rem);
	}

	.toolbar button,
	.toolbar output {
		min-block-size: 1.65rem;
		padding: 0.25rem 0.55rem;
		border: 0;
		border-radius: 0.35rem;
		background: color-mix(in srgb, var(--ga-outline) 18%, transparent);
		color: inherit;
		font: inherit;
		font-size: 0.67rem;
	}

	.toolbar button {
		cursor: pointer;
	}

	.toolbar button:hover {
		background: color-mix(in srgb, var(--ga-selection) 28%, transparent);
	}

	.empty {
		position: absolute;
		inset: 50% auto auto 50%;
		margin: 0;
		transform: translate(-50%, -50%);
		opacity: 0.56;
		pointer-events: none;
	}
</style>
