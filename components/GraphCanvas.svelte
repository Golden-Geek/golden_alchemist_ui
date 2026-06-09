<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type {
		GraphCamera,
		GraphConnectionRequest,
		GraphEdge,
		GraphNode,
		GraphNodeMove,
		GraphNodePosition,
		GraphNodeResize,
		GraphNodeSize,
		GraphSocket,
		GraphSocketDirection,
		GraphSocketRef
	} from '../types';

	interface PanGesture {
		pointerId: number;
		startX: number;
		startY: number;
		cameraX: number;
		cameraY: number;
		moved: boolean;
		clearSelectionOnClick: boolean;
	}

	interface NodeDragGesture {
		pointerId: number;
		startX: number;
		startY: number;
		nodePositions: Record<string, GraphNodePosition>;
	}

	interface NodeResizeGesture {
		pointerId: number;
		nodeId: string;
		startX: number;
		startY: number;
		startSize: GraphNodeSize;
	}

	interface SelectionGesture {
		pointerId: number;
		startX: number;
		startY: number;
		currentX: number;
		currentY: number;
		initialSelectedNodeIds: string[];
	}

	interface ConnectionDraft {
		pointerId: number;
		from: GraphSocketRef;
		endX: number;
		endY: number;
		snapNodeId?: string;
		snapSocketId?: string;
	}

	interface RoutingObstacle {
		left: number;
		top: number;
		right: number;
		bottom: number;
	}

	interface RoutingState {
		x: number;
		y: number;
		direction: number;
		cost: number;
		estimate: number;
		key: string;
	}

	let {
		nodes,
		edges,
		selectedNodeIds = [],
		selectedEdgeIds = [],
		onSelectionChange,
		onEdgeSelectionChange,
		onNodeMove,
		onNodesMove,
		onNodeResize,
		onConnect,
		nodeContent,
		onBackgroundContextMenu,
		routeEdgesAroundNodes = false,
		socketLabels = 'hover',
		initialCamera,
		onCameraChange,
		emptyLabel = 'No nodes in this graph.'
	}: {
		nodes: GraphNode[];
		edges: GraphEdge[];
		selectedNodeIds?: string[];
		selectedEdgeIds?: string[];
		onSelectionChange?: (nodeIds: string[]) => void;
		onEdgeSelectionChange?: (edgeIds: string[]) => void;
		onNodeMove?: (nodeId: string, position: GraphNodePosition) => void | Promise<void>;
		onNodesMove?: (moves: GraphNodeMove[]) => void | Promise<void>;
		onNodeResize?: (resize: GraphNodeResize) => void | Promise<void>;
		onConnect?: (connection: GraphConnectionRequest) => void;
		nodeContent?: Snippet<[GraphNode]>;
		onBackgroundContextMenu?: (event: MouseEvent, position: GraphNodePosition) => void;
		routeEdgesAroundNodes?: boolean;
		socketLabels?: 'always' | 'hover' | 'never';
		initialCamera?: GraphCamera;
		onCameraChange?: (camera: GraphCamera) => void;
		emptyLabel?: string;
	} = $props();

	const MIN_ZOOM = 0.2;
	const MAX_ZOOM = 2.5;
	const CHECKER_CELL_REM = 2;
	const DEFAULT_NODE_WIDTH_REM = 13;
	const MIN_NODE_WIDTH_REM = 8;
	const NODE_HEADER_REM = 1.8;
	const SOCKET_ROW_REM = 1.45;
	const SOCKET_START_REM = 2.05;
	const HEADER_SOCKET_INSET_REM = 0.47;
	const FRAME_PADDING_REM = 3;
	const CAMERA_ANIMATION_MS = 240;
	const ROUTING_GRID_REM = 1;
	const ROUTING_CLEARANCE_REM = 0.7;
	const ROUTING_MARGIN_REM = 16;
	const ROUTING_BUCKET_REM = 16;
	const ROUTING_MAX_VISITS = 24_000;
	const ROUTING_TURN_COST = 0.35;

	const finiteNumber = (value: number | undefined, fallback: number): number =>
		typeof value === 'number' && Number.isFinite(value) ? value : fallback;

	const normalizeCamera = (value: GraphCamera | undefined): GraphCamera => ({
		x: finiteNumber(value?.x, 0),
		y: finiteNumber(value?.y, 0),
		zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, finiteNumber(value?.zoom, 1)))
	});

	const cameraKey = (value: GraphCamera): string => `${value.x}:${value.y}:${value.zoom}`;

	let container: HTMLDivElement | null = $state(null);
	let camera = $state<GraphCamera>({ x: 0, y: 0, zoom: 1 });
	let appliedInitialCameraKey = $state<string | null>(null);
	let remPx = $state(16);
	let viewportWidth = $state(1);
	let viewportHeight = $state(1);
	let panGesture = $state<PanGesture | null>(null);
	let nodeDragGesture = $state<NodeDragGesture | null>(null);
	let nodeResizeGesture = $state<NodeResizeGesture | null>(null);
	let selectionGesture = $state<SelectionGesture | null>(null);
	let connectionDraft = $state<ConnectionDraft | null>(null);
	let dragPositions = $state<Record<string, GraphNodePosition>>({});
	let optimisticPositions = $state<Record<string, GraphNodePosition>>({});
	let resizeSizes = $state<Record<string, GraphNodeSize>>({});
	let optimisticSizes = $state<Record<string, GraphNodeSize>>({});
	let animationFrame: number | null = null;
	const routedPathCache = new Map<string, string>();

	let selectedIds = $derived(new Set(selectedNodeIds));
	let selectedEdgeIdSet = $derived(new Set(selectedEdgeIds));
	let effectiveNodes = $derived(
		nodes.map((node) => {
			const position = dragPositions[node.id] ?? optimisticPositions[node.id];
			const size = resizeSizes[node.id] ?? optimisticSizes[node.id];
			return position || size ? { ...node, ...position, ...size } : node;
		})
	);
	let nodesById = $derived(new Map(effectiveNodes.map((node) => [node.id, node])));
	let checkerCellSizePx = $derived(Math.max(8, remPx * CHECKER_CELL_REM * camera.zoom));
	let checkerSizePx = $derived(checkerCellSizePx * 2);
	let transformStyle = $derived(`translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`);
	let selectionBoxStyle = $derived.by(() => {
		if (!selectionGesture) {
			return '';
		}
		const left = Math.min(selectionGesture.startX, selectionGesture.currentX);
		const top = Math.min(selectionGesture.startY, selectionGesture.currentY);
		const width = Math.abs(selectionGesture.currentX - selectionGesture.startX);
		const height = Math.abs(selectionGesture.currentY - selectionGesture.startY);
		return `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
	});

	$effect(() => {
		let next = optimisticPositions;
		for (const node of nodes) {
			const optimistic = next[node.id];
			if (
				optimistic &&
				Math.abs(node.x - optimistic.x) < 0.0001 &&
				Math.abs(node.y - optimistic.y) < 0.0001
			) {
				if (next === optimisticPositions) {
					next = { ...optimisticPositions };
				}
				delete next[node.id];
			}
		}
		if (next !== optimisticPositions) {
			optimisticPositions = next;
		}
	});

	$effect(() => {
		let next = optimisticSizes;
		for (const node of nodes) {
			const optimistic = next[node.id];
			if (
				optimistic &&
				typeof node.width === 'number' &&
				typeof node.height === 'number' &&
				Math.abs(node.width - optimistic.width) < 0.0001 &&
				Math.abs(node.height - optimistic.height) < 0.0001
			) {
				if (next === optimisticSizes) {
					next = { ...optimisticSizes };
				}
				delete next[node.id];
			}
		}
		if (next !== optimisticSizes) {
			optimisticSizes = next;
		}
	});

	const clamp = (value: number, minimum: number, maximum: number): number =>
		Math.min(maximum, Math.max(minimum, value));

	const camerasMatch = (left: GraphCamera, right: GraphCamera): boolean =>
		Math.abs(left.x - right.x) < 0.0001 &&
		Math.abs(left.y - right.y) < 0.0001 &&
		Math.abs(left.zoom - right.zoom) < 0.0001;

	const applyCamera = (next: GraphCamera, notify = true): void => {
		const normalized = normalizeCamera(next);
		camera = normalized;
		if (notify) {
			onCameraChange?.({ ...normalized });
		}
	};

	const nodeWidth = (node: GraphNode): number =>
		Math.max(MIN_NODE_WIDTH_REM, node.width ?? DEFAULT_NODE_WIDTH_REM);

	const minimumNodeHeight = (node: GraphNode): number =>
		node.socketPlacement === 'header'
			? NODE_HEADER_REM + 1.2
			: Math.max(
					NODE_HEADER_REM + 1.2,
					NODE_HEADER_REM +
						1.4 +
						Math.max(node.inputs.length, node.outputs.length, 1) * SOCKET_ROW_REM
				);

	const nodeHeight = (node: GraphNode): number =>
		Math.max(minimumNodeHeight(node), node.height ?? minimumNodeHeight(node));

	let routingGeometryKey = $derived(
		`${remPx}:${effectiveNodes
			.map(
				(node) =>
					`${node.id}:${node.x}:${node.y}:${nodeWidth(node)}:${nodeHeight(node)}:${node.socketPlacement ?? 'body'}`
			)
			.join('|')}`
	);

	$effect(() => {
		routingGeometryKey;
		routedPathCache.clear();
	});

	let visibleNodes = $derived.by(() => {
		const margin = 8;
		const left = -camera.x / camera.zoom / remPx - margin;
		const top = -camera.y / camera.zoom / remPx - margin;
		const right = (viewportWidth - camera.x) / camera.zoom / remPx + margin;
		const bottom = (viewportHeight - camera.y) / camera.zoom / remPx + margin;
		return effectiveNodes.filter(
			(node) =>
				node.x + nodeWidth(node) >= left &&
				node.x <= right &&
				node.y + nodeHeight(node) >= top &&
				node.y <= bottom
		);
	});
	let visibleNodeIds = $derived(new Set(visibleNodes.map((node) => node.id)));
	let visibleEdges = $derived(
		edges.filter(
			(edge) => visibleNodeIds.has(edge.from.nodeId) || visibleNodeIds.has(edge.to.nodeId)
		)
	);
	let connectedSockets = $derived(
		new Set(
			edges.flatMap((edge) => [
				`${edge.from.nodeId}:${edge.from.socketId}`,
				`${edge.to.nodeId}:${edge.to.socketId}`
			])
		)
	);
	let routingObstacles = $derived.by((): RoutingObstacle[] => {
		const clearance = ROUTING_CLEARANCE_REM * remPx;
		return effectiveNodes.map((node) => ({
			left: node.x * remPx - clearance,
			top: node.y * remPx - clearance,
			right: (node.x + nodeWidth(node)) * remPx + clearance,
			bottom: (node.y + nodeHeight(node)) * remPx + clearance
		}));
	});
	let routingObstacleBuckets = $derived.by(() => {
		const buckets = new Map<string, RoutingObstacle[]>();
		const bucketSize = ROUTING_BUCKET_REM * remPx;
		for (const obstacle of routingObstacles) {
			const firstX = Math.floor(obstacle.left / bucketSize);
			const lastX = Math.floor(obstacle.right / bucketSize);
			const firstY = Math.floor(obstacle.top / bucketSize);
			const lastY = Math.floor(obstacle.bottom / bucketSize);
			for (let bucketX = firstX; bucketX <= lastX; bucketX += 1) {
				for (let bucketY = firstY; bucketY <= lastY; bucketY += 1) {
					const key = `${bucketX}:${bucketY}`;
					const entries = buckets.get(key);
					if (entries) {
						entries.push(obstacle);
					} else {
						buckets.set(key, [obstacle]);
					}
				}
			}
		}
		return buckets;
	});

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
		if (node.socketPlacement === 'header') {
			return {
				x:
					(node.x +
						(direction === 'output'
							? nodeWidth(node) - HEADER_SOCKET_INSET_REM
							: HEADER_SOCKET_INSET_REM)) *
					remPx,
				y: (node.y + NODE_HEADER_REM * 0.5) * remPx
			};
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

	const routingPointBlocked = (x: number, y: number): boolean => {
		const bucketSize = ROUTING_BUCKET_REM * remPx;
		const obstacles =
			routingObstacleBuckets.get(`${Math.floor(x / bucketSize)}:${Math.floor(y / bucketSize)}`) ??
			[];
		return obstacles.some(
			(obstacle) =>
				x >= obstacle.left && x <= obstacle.right && y >= obstacle.top && y <= obstacle.bottom
		);
	};

	const routingStateKey = (x: number, y: number, direction: number): string =>
		`${x}:${y}:${direction}`;

	const heapPush = (heap: RoutingState[], state: RoutingState): void => {
		heap.push(state);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = Math.floor((index - 1) * 0.5);
			if (heap[parent].estimate <= state.estimate) {
				break;
			}
			heap[index] = heap[parent];
			index = parent;
		}
		heap[index] = state;
	};

	const heapPop = (heap: RoutingState[]): RoutingState | null => {
		const first = heap[0];
		const last = heap.pop();
		if (!first || !last || heap.length === 0) {
			return first ?? null;
		}
		let index = 0;
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			if (left >= heap.length) {
				break;
			}
			const child =
				right < heap.length && heap[right].estimate < heap[left].estimate ? right : left;
			if (heap[child].estimate >= last.estimate) {
				break;
			}
			heap[index] = heap[child];
			index = child;
		}
		heap[index] = last;
		return first;
	};

	const simplifyRoute = (points: GraphNodePosition[]): GraphNodePosition[] => {
		const unique = points.filter(
			(point, index) =>
				index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
		);
		if (unique.length < 3) {
			return unique;
		}
		const simplified = [unique[0]];
		for (let index = 1; index < unique.length - 1; index += 1) {
			const previous = simplified[simplified.length - 1];
			const current = unique[index];
			const next = unique[index + 1];
			if (
				(previous.x === current.x && current.x === next.x) ||
				(previous.y === current.y && current.y === next.y)
			) {
				continue;
			}
			simplified.push(current);
		}
		simplified.push(unique.at(-1) ?? unique[0]);
		return simplified;
	};

	const pointInRect = (x: number, y: number, left: number, top: number, right: number, bottom: number) => 
		x > left && x < right && y > top && y < bottom;

	const lineIntersectsAnyObstacle = (x0: number, y0: number, x1: number, y1: number): boolean => {
		const minX = Math.min(x0, x1);
		const maxX = Math.max(x0, x1);
		const minY = Math.min(y0, y1);
		const maxY = Math.max(y0, y1);

		for (const obstacle of routingObstacles) {
			if (maxX <= obstacle.left || minX >= obstacle.right || maxY <= obstacle.top || minY >= obstacle.bottom) {
				continue;
			}
			if (pointInRect(x0, y0, obstacle.left, obstacle.top, obstacle.right, obstacle.bottom) ||
				pointInRect(x1, y1, obstacle.left, obstacle.top, obstacle.right, obstacle.bottom)) {
				return true;
			}
			
			const dx = x1 - x0;
			const dy = y1 - y0;
			if (dx === 0 || dy === 0) {
				if (dy === 0 && y0 > obstacle.top && y0 < obstacle.bottom && minX < obstacle.right && maxX > obstacle.left) return true;
				if (dx === 0 && x0 > obstacle.left && x0 < obstacle.right && minY < obstacle.bottom && maxY > obstacle.top) return true;
				continue;
			}

			const checkLine = (x3: number, y3: number, x4: number, y4: number) => {
				const den = (x0 - x1) * (y3 - y4) - (y0 - y1) * (x3 - x4);
				if (den === 0) return false;
				const t = ((x0 - x3) * (y3 - y4) - (y0 - y3) * (x3 - x4)) / den;
				const u = -((x0 - x1) * (y0 - y3) - (y0 - y1) * (x0 - x3)) / den;
				return t > 0 && t < 1 && u > 0 && u < 1;
			};

			if (checkLine(obstacle.left, obstacle.top, obstacle.right, obstacle.top) ||
				checkLine(obstacle.right, obstacle.top, obstacle.right, obstacle.bottom) ||
				checkLine(obstacle.right, obstacle.bottom, obstacle.left, obstacle.bottom) ||
				checkLine(obstacle.left, obstacle.bottom, obstacle.left, obstacle.top)) {
				return true;
			}
		}
		return false;
	};

	const smoothRoute = (points: GraphNodePosition[]): GraphNodePosition[] => {
		if (points.length <= 2) return points;
		
		const smoothed: GraphNodePosition[] = [points[0]];
		let currentIndex = 0;
		
		while (currentIndex < points.length - 1) {
			let furthestVisibleIndex = currentIndex + 1;
			
			for (let i = currentIndex + 2; i < points.length; i++) {
				if (!lineIntersectsAnyObstacle(points[currentIndex].x, points[currentIndex].y, points[i].x, points[i].y)) {
					furthestVisibleIndex = i;
				}
			}
			
			smoothed.push(points[furthestVisibleIndex]);
			currentIndex = furthestVisibleIndex;
		}
		
		return smoothed;
	};

	const roundedPath = (points: GraphNodePosition[], radius: number): string => {
		if (points.length < 3) {
			return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
		}
		let path = `M ${points[0].x} ${points[0].y}`;
		for (let i = 1; i < points.length - 1; i++) {
			const prev = points[i - 1];
			const curr = points[i];
			const next = points[i + 1];

			const dPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
			const dNext = Math.hypot(next.x - curr.x, next.y - curr.y);
			
			if (dPrev < 0.1 || dNext < 0.1) {
				path += ` L ${curr.x} ${curr.y}`;
				continue;
			}
			
			const r = Math.min(radius, dPrev / 2, dNext / 2);
			
			if (r <= 0.1) {
				path += ` L ${curr.x} ${curr.y}`;
				continue;
			}
			
			const startX = curr.x - (curr.x - prev.x) * (r / dPrev);
			const startY = curr.y - (curr.y - prev.y) * (r / dPrev);
			
			const endX = curr.x + (next.x - curr.x) * (r / dNext);
			const endY = curr.y + (next.y - curr.y) * (r / dNext);
			
			path += ` L ${startX} ${startY} Q ${curr.x} ${curr.y} ${endX} ${endY}`;
		}
		path += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
		return path;
	};

	const findOrthogonalRoute = (
		start: GraphNodePosition,
		end: GraphNodePosition
	): GraphNodePosition[] | null => {
		const grid = ROUTING_GRID_REM * remPx;
		const margin = ROUTING_MARGIN_REM * remPx;
		const sourceX = Math.ceil(start.x / grid);
		const sourceY = Math.round(start.y / grid);
		const targetX = Math.floor(end.x / grid);
		const targetY = Math.round(end.y / grid);
		const minX = Math.floor((Math.min(start.x, end.x) - margin) / grid);
		const maxX = Math.ceil((Math.max(start.x, end.x) + margin) / grid);
		const minY = Math.floor((Math.min(start.y, end.y) - margin) / grid);
		const maxY = Math.ceil((Math.max(start.y, end.y) + margin) / grid);
		const directions = [
			{ x: 1, y: 0 },
			{ x: 0, y: 1 },
			{ x: -1, y: 0 },
			{ x: 0, y: -1 }
		];
		const open: RoutingState[] = [];
		const costs = new Map<string, number>();
		const parents = new Map<string, string>();
		const states = new Map<string, RoutingState>();
		const startState: RoutingState = {
			x: sourceX,
			y: sourceY,
			direction: -1,
			cost: 0,
			estimate: Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY),
			key: routingStateKey(sourceX, sourceY, -1)
		};
		costs.set(startState.key, 0);
		states.set(startState.key, startState);
		heapPush(open, startState);

		let visits = 0;
		let goal: RoutingState | null = null;
		while (open.length > 0 && visits < ROUTING_MAX_VISITS) {
			const current = heapPop(open);
			if (!current || current.cost !== costs.get(current.key)) {
				continue;
			}
			visits += 1;
			if (current.x === targetX && current.y === targetY) {
				goal = current;
				break;
			}
			for (let direction = 0; direction < directions.length; direction += 1) {
				const nextX = current.x + directions[direction].x;
				const nextY = current.y + directions[direction].y;
				if (nextX < minX || nextX > maxX || nextY < minY || nextY > maxY) {
					continue;
				}
				if (routingPointBlocked(nextX * grid, nextY * grid)) {
					continue;
				}
				const turnCost =
					current.direction >= 0 && current.direction !== direction ? ROUTING_TURN_COST : 0;
				const nextCost = current.cost + 1 + turnCost;
				const key = routingStateKey(nextX, nextY, direction);
				if (nextCost >= (costs.get(key) ?? Number.POSITIVE_INFINITY)) {
					continue;
				}
				const next: RoutingState = {
					x: nextX,
					y: nextY,
					direction,
					cost: nextCost,
					estimate: nextCost + Math.abs(targetX - nextX) + Math.abs(targetY - nextY),
					key
				};
				costs.set(key, nextCost);
				parents.set(key, current.key);
				states.set(key, next);
				heapPush(open, next);
			}
		}
		if (!goal) {
			return null;
		}
		const points: GraphNodePosition[] = [];
		let key: string | undefined = goal.key;
		while (key) {
			const state = states.get(key);
			if (!state) {
				break;
			}
			points.push({ x: state.x * grid, y: state.y * grid });
			key = parents.get(key);
		}
		points.reverse();
		return simplifyRoute(points);
	};

	const routedWirePath = (
		edge: GraphEdge,
		start: GraphNodePosition,
		end: GraphNodePosition
	): string | null => {
		const sourceNode = nodesById.get(edge.from.nodeId);
		const targetNode = nodesById.get(edge.to.nodeId);
		if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) {
			return null;
		}
		const grid = ROUTING_GRID_REM * remPx;
		const clearance = ROUTING_CLEARANCE_REM * remPx;
		const routeStart = {
			x:
				Math.ceil(((sourceNode.x + nodeWidth(sourceNode)) * remPx + clearance) / grid) * grid +
				grid,
			y: start.y
		};
		const routeEnd = {
			x: Math.floor((targetNode.x * remPx - clearance) / grid) * grid - grid,
			y: end.y
		};
		const gridStart = { x: routeStart.x, y: Math.round(routeStart.y / grid) * grid };
		const gridEnd = { x: routeEnd.x, y: Math.round(routeEnd.y / grid) * grid };
		const middle = findOrthogonalRoute(gridStart, gridEnd);
		if (!middle) {
			return null;
		}
		
		let points = simplifyRoute([routeStart, gridStart, ...middle, gridEnd, routeEnd]);
		points = smoothRoute(points);
		points = simplifyRoute([start, ...points, end]);
		
		return roundedPath(points, remPx * 1.5);
	};

	const edgePath = (edge: GraphEdge): string | null => {
		const start = socketPoint(edge.from, 'output');
		const end = socketPoint(edge.to, 'input');
		if (!start || !end) {
			return null;
		}
		if (!routeEdgesAroundNodes) {
			return wirePath(start, end);
		}
		const cacheKey = `${edge.id ?? ''}:${edge.from.nodeId}:${edge.from.socketId}:${edge.to.nodeId}:${edge.to.socketId}`;
		const cached = routedPathCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const path = routedWirePath(edge, start, end) ?? wirePath(start, end);
		routedPathCache.set(cacheKey, path);
		return path;
	};

	const draftPath = (): string | null => {
		if (!connectionDraft) {
			return null;
		}
		const start = socketPoint(connectionDraft.from, 'output');
		if (!start) return null;
		
		if (connectionDraft.snapNodeId && connectionDraft.snapSocketId) {
			const end = socketPoint({ nodeId: connectionDraft.snapNodeId, socketId: connectionDraft.snapSocketId }, 'input');
			if (end) return wirePath(start, end);
		}
		
		return wirePath(start, { x: connectionDraft.endX, y: connectionDraft.endY });
	};

	const clientToWorldPx = (clientX: number, clientY: number): { x: number; y: number } => {
		const bounds = container?.getBoundingClientRect();
		return {
			x: (clientX - (bounds?.left ?? 0) - camera.x) / camera.zoom,
			y: (clientY - (bounds?.top ?? 0) - camera.y) / camera.zoom
		};
	};

	const cameraAtZoom = (zoom: number, anchorX: number, anchorY: number): GraphCamera => {
		const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
		const worldX = (anchorX - camera.x) / camera.zoom;
		const worldY = (anchorY - camera.y) / camera.zoom;
		return {
			x: anchorX - worldX * nextZoom,
			y: anchorY - worldY * nextZoom,
			zoom: nextZoom
		};
	};

	const cancelCameraAnimation = (): void => {
		if (animationFrame !== null) {
			cancelAnimationFrame(animationFrame);
			animationFrame = null;
		}
	};

	$effect(() => {
		if (!initialCamera) {
			return;
		}
		const normalized = normalizeCamera(initialCamera);
		const key = cameraKey(normalized);
		if (key === appliedInitialCameraKey) {
			return;
		}
		appliedInitialCameraKey = key;
		if (!camerasMatch(camera, normalized)) {
			cancelCameraAnimation();
			applyCamera(normalized, false);
		}
	});

	const animateCamera = (target: GraphCamera): void => {
		cancelCameraAnimation();
		const source = { ...camera };
		const startedAt = performance.now();
		const tick = (now: number): void => {
			const progress = clamp((now - startedAt) / CAMERA_ANIMATION_MS, 0, 1);
			const eased = 1 - (1 - progress) ** 3;
			applyCamera({
				x: source.x + (target.x - source.x) * eased,
				y: source.y + (target.y - source.y) * eased,
				zoom: source.zoom + (target.zoom - source.zoom) * eased
			});
			if (progress < 1) {
				animationFrame = requestAnimationFrame(tick);
			} else {
				animationFrame = null;
			}
		};
		animationFrame = requestAnimationFrame(tick);
	};

	const setZoom = (zoom: number): void => {
		cancelCameraAnimation();
		applyCamera(cameraAtZoom(zoom, viewportWidth * 0.5, viewportHeight * 0.5));
	};

	const resetZoom = (): void => {
		animateCamera(cameraAtZoom(1, viewportWidth * 0.5, viewportHeight * 0.5));
	};

	const handleZoomInput = (event: Event): void => {
		setZoom((event.currentTarget as HTMLInputElement).valueAsNumber / 100);
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

	export const clientToWorld = (clientX: number, clientY: number): GraphNodePosition => {
		const world = clientToWorldPx(clientX, clientY);
		return {
			x: world.x / remPx,
			y: world.y / remPx
		};
	};

	export const viewportCenter = (): GraphNodePosition => ({
		x: (viewportWidth * 0.5 - camera.x) / camera.zoom / remPx,
		y: (viewportHeight * 0.5 - camera.y) / camera.zoom / remPx
	});

	const updateSelection = (nodeId: string, additive: boolean): void => {
		const next = additive ? new Set(selectedIds) : new Set<string>();
		if (additive && next.has(nodeId)) {
			next.delete(nodeId);
		} else {
			next.add(nodeId);
		}
		onSelectionChange?.([...next]);
	};

	const updateEdgeSelection = (edge: GraphEdge, additive: boolean): void => {
		if (!edge.id) {
			return;
		}
		const next = additive ? new Set(selectedEdgeIdSet) : new Set<string>();
		if (additive && next.has(edge.id)) {
			next.delete(edge.id);
		} else {
			next.add(edge.id);
		}
		onEdgeSelectionChange?.([...next]);
	};

	const selectEdge = (event: PointerEvent, edge: GraphEdge): void => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		container?.focus();
		updateEdgeSelection(edge, event.ctrlKey || event.metaKey || event.shiftKey);
	};

	const selectEdgeWithKeyboard = (event: KeyboardEvent, edge: GraphEdge): void => {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		updateEdgeSelection(edge, event.ctrlKey || event.metaKey || event.shiftKey);
	};

	const localPointerPosition = (event: PointerEvent): { x: number; y: number } => {
		const bounds = container?.getBoundingClientRect();
		return {
			x: event.clientX - (bounds?.left ?? 0),
			y: event.clientY - (bounds?.top ?? 0)
		};
	};

	const finishSelectionGesture = (): void => {
		if (!selectionGesture) {
			return;
		}
		const left = Math.min(selectionGesture.startX, selectionGesture.currentX);
		const top = Math.min(selectionGesture.startY, selectionGesture.currentY);
		const right = Math.max(selectionGesture.startX, selectionGesture.currentX);
		const bottom = Math.max(selectionGesture.startY, selectionGesture.currentY);
		if (right - left < 3 && bottom - top < 3) {
			selectionGesture = null;
			return;
		}
		const next = new Set(selectionGesture.initialSelectedNodeIds);
		for (const node of effectiveNodes) {
			const nodeLeft = camera.x + node.x * remPx * camera.zoom;
			const nodeTop = camera.y + node.y * remPx * camera.zoom;
			const nodeRight = nodeLeft + nodeWidth(node) * remPx * camera.zoom;
			const nodeBottom = nodeTop + nodeHeight(node) * remPx * camera.zoom;
			if (nodeRight >= left && nodeLeft <= right && nodeBottom >= top && nodeTop <= bottom) {
				next.add(node.id);
			}
		}
		onSelectionChange?.([...next]);
		selectionGesture = null;
	};

	const startPan = (event: PointerEvent): void => {
		if (event.button !== 0 && event.button !== 1) {
			return;
		}
		container?.focus();
		if (event.button === 0 && event.shiftKey) {
			const pointer = localPointerPosition(event);
			selectionGesture = {
				pointerId: event.pointerId,
				startX: pointer.x,
				startY: pointer.y,
				currentX: pointer.x,
				currentY: pointer.y,
				initialSelectedNodeIds: [...selectedIds]
			};
			container?.setPointerCapture(event.pointerId);
			return;
		}
		panGesture = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			cameraX: camera.x,
			cameraY: camera.y,
			moved: false,
			clearSelectionOnClick: event.button === 0
		};
		container?.setPointerCapture(event.pointerId);
	};

	const selectNodeBody = (event: PointerEvent, node: GraphNode): void => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		container?.focus();
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('button, input, textarea, select, a, [data-no-node-select]')
		) {
			return;
		}
		if (event.ctrlKey || event.metaKey || event.shiftKey) {
			updateSelection(node.id, true);
		} else if (!selectedIds.has(node.id)) {
			updateSelection(node.id, false);
		}
	};

	const startNodeDrag = (event: PointerEvent, node: GraphNode): void => {
		if (event.button !== 0) {
			return;
		}
		event.stopPropagation();
		container?.focus();
		const additive = event.ctrlKey || event.metaKey || event.shiftKey;
		let dragIds: Set<string>;
		if (additive) {
			const next = new Set(selectedIds);
			if (next.has(node.id)) {
				next.delete(node.id);
			} else {
				next.add(node.id);
			}
			onSelectionChange?.([...next]);
			if (!next.has(node.id)) {
				return;
			}
			dragIds = next;
		} else if (selectedIds.has(node.id)) {
			dragIds = new Set(selectedIds);
		} else {
			updateSelection(node.id, false);
			dragIds = new Set([node.id]);
		}
		const nodePositions: Record<string, GraphNodePosition> = {};
		for (const dragId of dragIds) {
			const dragNode = nodesById.get(dragId);
			if (dragNode) {
				nodePositions[dragId] = { x: dragNode.x, y: dragNode.y };
			}
		}
		nodeDragGesture = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			nodePositions
		};
		container?.setPointerCapture(event.pointerId);
	};

	const startNodeResize = (event: PointerEvent, node: GraphNode): void => {
		if (event.button !== 0 || !node.resizable) {
			return;
		}
		event.stopPropagation();
		container?.focus();
		if (!selectedIds.has(node.id)) {
			updateSelection(node.id, false);
		}
		nodeResizeGesture = {
			pointerId: event.pointerId,
			nodeId: node.id,
			startX: event.clientX,
			startY: event.clientY,
			startSize: {
				width: nodeWidth(node),
				height: nodeHeight(node)
			}
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

	const completeConnection = (nodeId: string, socket: GraphSocket): boolean => {
		if (!connectionDraft || socket.compatible === false) {
			return false;
		}
		onConnect?.({
			from: connectionDraft.from,
			to: { nodeId, socketId: socket.id }
		});
		connectionDraft = null;
		return true;
	};

	const finishConnection = (event: PointerEvent, nodeId: string, socket: GraphSocket): void => {
		if (completeConnection(nodeId, socket)) {
			event.stopPropagation();
		}
	};

	const finishConnectionAtPointer = (event: PointerEvent): void => {
		if (connectionDraft?.snapNodeId && connectionDraft?.snapSocketId) {
			const socket = nodesById.get(connectionDraft.snapNodeId)?.inputs.find((candidate) => candidate.id === connectionDraft!.snapSocketId);
			if (socket) {
				completeConnection(connectionDraft.snapNodeId, socket);
				return;
			}
		}

		const target = document.elementFromPoint(event.clientX, event.clientY);
		const inputSocket =
			target instanceof Element
				? target.closest<HTMLButtonElement>('.socket.input[data-node-id][data-socket-id]')
				: null;
		const nodeId = inputSocket?.dataset.nodeId;
		const socketId = inputSocket?.dataset.socketId;
		if (!nodeId || !socketId) {
			return;
		}
		const socket = nodesById.get(nodeId)?.inputs.find((candidate) => candidate.id === socketId);
		if (socket) {
			completeConnection(nodeId, socket);
		}
	};

	const handlePointerMove = (event: PointerEvent): void => {
		if (selectionGesture?.pointerId === event.pointerId) {
			const pointer = localPointerPosition(event);
			selectionGesture = {
				...selectionGesture,
				currentX: pointer.x,
				currentY: pointer.y
			};
			return;
		}
		if (panGesture?.pointerId === event.pointerId) {
			const deltaX = event.clientX - panGesture.startX;
			const deltaY = event.clientY - panGesture.startY;
			if (!panGesture.moved && Math.hypot(deltaX, deltaY) >= 3) {
				panGesture = { ...panGesture, moved: true };
			}
			applyCamera({
				...camera,
				x: panGesture.cameraX + deltaX,
				y: panGesture.cameraY + deltaY
			});
			return;
		}
		if (nodeDragGesture?.pointerId === event.pointerId) {
			const deltaX = (event.clientX - nodeDragGesture.startX) / camera.zoom / remPx;
			const deltaY = (event.clientY - nodeDragGesture.startY) / camera.zoom / remPx;
			const nextPositions: Record<string, GraphNodePosition> = {};
			for (const [nodeId, position] of Object.entries(nodeDragGesture.nodePositions)) {
				nextPositions[nodeId] = {
					x: position.x + deltaX,
					y: position.y + deltaY
				};
			}
			dragPositions = nextPositions;
			return;
		}
		if (nodeResizeGesture?.pointerId === event.pointerId) {
			const node = nodesById.get(nodeResizeGesture.nodeId);
			if (!node) {
				return;
			}
			const deltaX = (event.clientX - nodeResizeGesture.startX) / camera.zoom / remPx;
			const deltaY = (event.clientY - nodeResizeGesture.startY) / camera.zoom / remPx;
			resizeSizes = {
				...resizeSizes,
				[node.id]: {
					width: Math.max(MIN_NODE_WIDTH_REM, nodeResizeGesture.startSize.width + deltaX),
					height: Math.max(minimumNodeHeight(node), nodeResizeGesture.startSize.height + deltaY)
				}
			};
			return;
		}
		if (connectionDraft?.pointerId === event.pointerId) {
			const world = clientToWorldPx(event.clientX, event.clientY);
			
			let bestSnapDist = remPx * 4; // max snap distance
			let bestNodeId: string | undefined = undefined;
			let bestSocketId: string | undefined = undefined;
			
			for (const node of effectiveNodes) {
				if (node.id === connectionDraft.from.nodeId) continue;
				
				for (const socket of node.inputs) {
					if (socket.compatible === false) continue;
					const pt = socketPoint({ nodeId: node.id, socketId: socket.id }, 'input');
					if (!pt) continue;
					
					const dist = Math.hypot(world.x - pt.x, world.y - pt.y);
					if (dist < bestSnapDist) {
						bestSnapDist = dist;
						bestNodeId = node.id;
						bestSocketId = socket.id;
					}
				}
				
				// Snap to node header if close to the node bounds and it has exactly one compatible input
				if (node.inputs.length === 1 && node.inputs[0].compatible !== false) {
					const left = node.x * remPx;
					const top = node.y * remPx;
					const right = left + nodeWidth(node) * remPx;
					const bottom = top + nodeHeight(node) * remPx;
					
					// If inside node bounds or slightly expanded bounds
					const margin = remPx * 1;
					if (world.x >= left - margin && world.x <= right + margin && world.y >= top - margin && world.y <= bottom + margin) {
						// Only snap to the whole node if it's better than our current best distance
						// Being inside the node bounds is considered distance 0
						if (bestSnapDist > 0) {
							bestSnapDist = 0; // Prioritize this since we are directly over the node
							bestNodeId = node.id;
							bestSocketId = node.inputs[0].id;
						}
					}
				}
			}
			
			connectionDraft = { ...connectionDraft, endX: world.x, endY: world.y, snapNodeId: bestNodeId, snapSocketId: bestSocketId };
		}
	};

	const clearOptimisticMoves = (moves: GraphNodeMove[]): void => {
		const next = { ...optimisticPositions };
		let changed = false;
		for (const move of moves) {
			const pending = next[move.nodeId];
			if (pending?.x === move.position.x && pending?.y === move.position.y) {
				delete next[move.nodeId];
				changed = true;
			}
		}
		if (changed) {
			optimisticPositions = next;
		}
	};

	const commitNodeMoves = (moves: GraphNodeMove[]): void => {
		optimisticPositions = {
			...optimisticPositions,
			...Object.fromEntries(moves.map((move) => [move.nodeId, move.position]))
		};
		try {
			const result = onNodesMove
				? onNodesMove(moves)
				: Promise.all(moves.map((move) => onNodeMove?.(move.nodeId, move.position)));
			void Promise.resolve(result).catch(() => clearOptimisticMoves(moves));
		} catch {
			clearOptimisticMoves(moves);
		}
	};

	const clearOptimisticResize = (resize: GraphNodeResize): void => {
		const pending = optimisticSizes[resize.nodeId];
		if (pending?.width === resize.size.width && pending?.height === resize.size.height) {
			const next = { ...optimisticSizes };
			delete next[resize.nodeId];
			optimisticSizes = next;
		}
	};

	const commitNodeResize = (resize: GraphNodeResize): void => {
		optimisticSizes = {
			...optimisticSizes,
			[resize.nodeId]: resize.size
		};
		try {
			void Promise.resolve(onNodeResize?.(resize)).catch(() => clearOptimisticResize(resize));
		} catch {
			clearOptimisticResize(resize);
		}
	};

	const handlePointerEnd = (event: PointerEvent): void => {
		if (selectionGesture?.pointerId === event.pointerId) {
			finishSelectionGesture();
		}
		if (panGesture?.pointerId === event.pointerId) {
			if (!panGesture.moved && panGesture.clearSelectionOnClick) {
				onSelectionChange?.([]);
			}
			panGesture = null;
		}
		if (nodeDragGesture?.pointerId === event.pointerId) {
			const moves = Object.entries(dragPositions).map(
				([nodeId, position]): GraphNodeMove => ({ nodeId, position })
			);
			if (moves.length > 0) {
				commitNodeMoves(moves);
			}
			dragPositions = {};
			nodeDragGesture = null;
		}
		if (nodeResizeGesture?.pointerId === event.pointerId) {
			const size = resizeSizes[nodeResizeGesture.nodeId];
			if (size) {
				commitNodeResize({
					nodeId: nodeResizeGesture.nodeId,
					size
				});
			}
			resizeSizes = {};
			nodeResizeGesture = null;
		}
		if (connectionDraft?.pointerId === event.pointerId) {
			finishConnectionAtPointer(event);
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
		cancelCameraAnimation();
		applyCamera(cameraAtZoom(camera.zoom * Math.exp(-event.deltaY * 0.0014), pointerX, pointerY));
	};

	const handleContextMenu = (event: MouseEvent): void => {
		const target = event.target;
		if (
			!onBackgroundContextMenu ||
			(target instanceof Element && target.closest('.node, .toolbar'))
		) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		onBackgroundContextMenu?.(event, clientToWorld(event.clientX, event.clientY));
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
		if (!initialCamera) {
			requestAnimationFrame(() => home());
		}
		return () => {
			observer.disconnect();
			cancelCameraAnimation();
		};
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={container}
	class:panning={panGesture !== null}
	class:node-dragging={nodeDragGesture !== null}
	class:node-resizing={nodeResizeGesture !== null}
	class:selecting={selectionGesture !== null}
	class:connecting={connectionDraft !== null}
	class="graph-canvas"
	data-socket-labels={socketLabels}
	role="application"
	aria-label="Node graph"
	tabindex="0"
	style:--checker-size={`${checkerSizePx}px`}
	style:--camera-x={`${camera.x}px`}
	style:--camera-y={`${camera.y}px`}
	onpointerdown={startPan}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerEnd}
	onpointercancel={handlePointerEnd}
	onkeydown={handleKeydown}
	onwheel={handleWheel}
	oncontextmenu={handleContextMenu}>
	<div
		class="toolbar"
		role="group"
		aria-label="Graph view controls"
		onpointerdown={(event) => event.stopPropagation()}>
		<button type="button" title="Frame selection (F)" onclick={frameSelection}>Frame</button>
		<button type="button" title="Home (H)" onclick={home}>Home</button>
		<div class="zoom-control">
			<input
				class="zoom-slider"
				type="range"
				min={MIN_ZOOM * 100}
				max={MAX_ZOOM * 100}
				step="1"
				value={camera.zoom * 100}
				aria-label="Zoom"
				title="Zoom"
				oninput={handleZoomInput} />
			<button
				type="button"
				class="zoom-reset"
				aria-label="Reset zoom to 100%"
				title="Reset zoom to 100%"
				onclick={resetZoom}>
				{Math.round(camera.zoom * 100)}%
			</button>
		</div>
	</div>

	<div class="world" style:transform={transformStyle}>
		<svg class="wires" aria-label="Graph connections">
			{#each visibleEdges as edge, index (`${edge.id ?? index}:${edge.from.nodeId}:${edge.to.nodeId}`)}
				{@const path = edgePath(edge)}
				{#if path}
					<path
						d={path}
						class="edge-hit"
						role="button"
						tabindex="0"
						aria-label="Select connection"
						aria-pressed={edge.id !== undefined && selectedEdgeIdSet.has(edge.id)}
						vector-effect="non-scaling-stroke"
						onpointerdown={(event) => selectEdge(event, edge)}
						onkeydown={(event) => selectEdgeWithKeyboard(event, edge)} />
					<path
						d={path}
						class="edge"
						class:active={edge.active}
						class:invalid={edge.invalid}
						class:selected={edge.id !== undefined && selectedEdgeIdSet.has(edge.id)}
						style:--edge-color={edge.color}
						vector-effect="non-scaling-stroke" />
				{/if}
			{/each}
			{#if draftPath()}
				<path class="draft" d={draftPath() ?? ''} vector-effect="non-scaling-stroke" />
			{/if}
		</svg>

		{#each visibleNodes as node (node.id)}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<article
				class:selected={selectedIds.has(node.id)}
				class:active={node.active}
				class:invalid={node.invalid}
				class:draft-target={connectionDraft?.snapNodeId === node.id}
				class="node"
				style:left={`${node.x}rem`}
				style:top={`${node.y}rem`}
				style:width={`${nodeWidth(node)}rem`}
				style:height={`${nodeHeight(node)}rem`}
				onpointerdown={(event) => selectNodeBody(event, node)}>
				<div class="node-header">
					{#if node.socketPlacement === 'header'}
						<div class="header-socket-list inputs">
							{#each node.inputs as socket (socket.id)}
								<button
									type="button"
									class:incompatible={socket.compatible === false}
									class:connected={connectedSockets.has(`${node.id}:${socket.id}`)}
									class:draft-target={connectionDraft?.snapNodeId === node.id && connectionDraft?.snapSocketId === socket.id}
									class="socket header-socket input"
									data-node-id={node.id}
									data-socket-id={socket.id}
									title={socket.valueType ?? socket.label}
									onpointerup={(event) => finishConnection(event, node.id, socket)}>
									<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}
									></span>
									<span>{socket.label}</span>
								</button>
							{/each}
						</div>
					{/if}
					<button
						type="button"
						class="node-title"
						onpointerdown={(event) => startNodeDrag(event, node)}>
						<strong>{node.label}</strong>
						{#if node.subtitle}<small>{node.subtitle}</small>{/if}
					</button>
					{#if node.socketPlacement === 'header'}
						<div class="header-socket-list outputs">
							{#each node.outputs as socket (socket.id)}
								<button
									type="button"
									class:incompatible={socket.compatible === false}
									class:connected={connectedSockets.has(`${node.id}:${socket.id}`)}
									class="socket header-socket output"
									title={socket.valueType ?? socket.label}
									onpointerdown={(event) => startConnection(event, node.id, socket)}>
									<span>{socket.label}</span>
									<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}
									></span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<div class="node-body">
					{#if node.socketPlacement !== 'header'}
						<div class="socket-columns">
							<div class="socket-list inputs">
								{#each node.inputs as socket (socket.id)}
									<button
										type="button"
										class:incompatible={socket.compatible === false}
										class:connected={connectedSockets.has(`${node.id}:${socket.id}`)}
										class:draft-target={connectionDraft?.snapNodeId === node.id && connectionDraft?.snapSocketId === socket.id}
										class="socket input"
										data-node-id={node.id}
										data-socket-id={socket.id}
										title={socket.valueType ?? socket.label}
										onpointerup={(event) => finishConnection(event, node.id, socket)}>
										<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}
										></span>
										<span>{socket.label}</span>
									</button>
								{/each}
							</div>
							<div class="socket-list outputs">
								{#each node.outputs as socket (socket.id)}
									<button
										type="button"
										class:incompatible={socket.compatible === false}
										class:connected={connectedSockets.has(`${node.id}:${socket.id}`)}
										class="socket output"
										title={socket.valueType ?? socket.label}
										onpointerdown={(event) => startConnection(event, node.id, socket)}>
										<span>{socket.label}</span>
										<span class="pin" style:--socket-color={socket.color ?? 'var(--ga-socket)'}
										></span>
									</button>
								{/each}
							</div>
						</div>
					{/if}
					{#if nodeContent}
						<div class="node-content" data-no-node-select>
							{@render nodeContent(node)}
						</div>
					{/if}
				</div>
				{#if node.resizable}
					<button
						type="button"
						class="resize-handle"
						aria-label={`Resize ${node.label}`}
						title={`Resize ${node.label}`}
						onpointerdown={(event) => startNodeResize(event, node)}></button>
				{/if}
			</article>
		{/each}
	</div>

	{#if selectionGesture}
		<div class="selection-box" style={selectionBoxStyle}></div>
	{/if}

	{#if nodes.length === 0}
		<p class="empty">{emptyLabel}</p>
	{/if}
</div>

<style>
	.graph-canvas {
		--ga-bg: var(--gc-color-background, #11151b);
		--ga-grid-odd: var(--gc-color-graph-grid-odd, var(--ga-bg));
		--ga-grid-even: var(
			--gc-color-graph-grid-even,
			color-mix(in srgb, var(--gc-color-text, #d8dfeb) 5%, var(--ga-bg))
		);
		--ga-node: color-mix(in srgb, var(--gc-color-background, #11151b) 80%, #293449);
		--ga-outline: var(--gc-color-panel-outline, #536077);
		--ga-selection: var(--gc-color-selection, #66a6ff);
		--ga-active: #f2c01a;
		--ga-error: #ff6d75;
		--ga-socket: #b4c2d8;
		position: relative;
		inline-size: 100%;
		block-size: 100%;
		min-inline-size: 0;
		min-block-size: 0;
		overflow: hidden;
		outline: none;
		background-color: var(--ga-grid-odd);
		background-image: conic-gradient(
			from 90deg,
			var(--ga-grid-even) 25%,
			var(--ga-grid-odd) 0 50%,
			var(--ga-grid-even) 0 75%,
			var(--ga-grid-odd) 0
		);
		background-position: var(--camera-x, 0) var(--camera-y, 0);
		background-size: var(--checker-size) var(--checker-size);
		user-select: none;
		cursor: default;
	}

	.graph-canvas.panning,
	.graph-canvas.node-dragging,
	.graph-canvas.connecting {
		cursor: grabbing;
	}

	.graph-canvas.node-resizing {
		cursor: nwse-resize;
	}

	.graph-canvas.selecting {
		cursor: crosshair;
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
		/* z-index: 2; */
	}

	.wires path {
		fill: none;
	}

	.wires path.edge {
		stroke: color-mix(in srgb, var(--ga-socket) 72%, transparent);
		stroke-width: 0.16rem;
		pointer-events: none;
	}

	.wires path.edge.active {
		stroke: var(--edge-color, var(--ga-active));
		filter: drop-shadow(0 0 0.22rem color-mix(in srgb, var(--ga-active) 65%, transparent));
	}

	.wires path.edge:not(.active) {
		stroke: var(--edge-color, color-mix(in srgb, var(--ga-socket) 72%, transparent));
	}

	.wires path.edge.selected {
		stroke: var(--ga-selection);
		stroke-width: 0.25rem;
		filter: drop-shadow(0 0 0.24rem color-mix(in srgb, var(--ga-selection) 72%, transparent));
	}

	.wires path.edge.invalid {
		stroke: var(--ga-error);
		stroke-dasharray: 0.4rem 0.3rem;
	}

	.wires path.edge-hit {
		stroke: transparent;
		stroke-width: 0.85rem;
		pointer-events: stroke;
		cursor: pointer;
	}

	.wires path.draft {
		stroke: var(--ga-selection);
		stroke-dasharray: 0.45rem 0.25rem;
	}

	.selection-box {
		position: absolute;
		z-index: 15;
		box-sizing: border-box;
		border: solid 0.08rem color-mix(in srgb, var(--ga-selection) 82%, transparent);
		background: color-mix(in srgb, var(--ga-selection) 14%, transparent);
		pointer-events: none;
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
		transition:
			border-color 0.1s ease,
			box-shadow 0.1s ease;
	}

	.node.selected {
		border-color: var(--ga-selection);
	}

	.node.active {
		border-color: var(--ga-active);
	}

	.node.selected.active {
		box-shadow: 0 0 0.5rem color-mix(in srgb, var(--gc-color-selection) 70%, transparent);
	}

	.node.invalid {
		border-color: var(--ga-error);
	}

	.node.draft-target {
		border-color: var(--ga-selection);
		box-shadow: 0 0 0.8rem color-mix(in srgb, var(--gc-color-selection) 60%, transparent);
	}

	.socket.draft-target .pin {
		background: var(--ga-selection);
		box-shadow: 0 0 0.4rem var(--ga-selection);
	}

	.node-header {
		position: relative;
		display: flex;
		align-items: stretch;
		inline-size: 100%;
		min-block-size: 1.8rem;
		box-sizing: border-box;
		border-block-end: solid 0.06rem color-mix(in srgb, var(--ga-outline) 55%, transparent);
		border-radius: 0.48rem 0.48rem 0 0;
		background: color-mix(in srgb, var(--ga-outline) 12%, var(--ga-node));
		color: inherit;
	}

	.node-title {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		justify-content: center;
		min-inline-size: 0;
		padding: 0.25rem 0.35rem;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: default;
	}

	.graph-canvas.node-dragging .node-title {
		cursor: grabbing;
	}

	.node.active .node-header {
		background: color-mix(in srgb, var(--ga-active) 22%, var(--ga-node));
	}

	.node strong,
	.node small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node strong {
		font-size: 0.76rem;
	}

	.node small {
		font-size: 0.64rem;
		opacity: 0.62;
	}

	.header-socket-list {
		display: flex;
		flex: 0 0 auto;
		align-items: stretch;
		min-inline-size: 0;
	}

	.header-socket {
		block-size: 100%;
		min-block-size: 1.72rem;
		font-size: 0.64rem;
	}

	.node-body {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		block-size: calc(100% - 1.8rem);
		min-block-size: 2.2rem;
		overflow: hidden;
	}

	.socket-columns {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-content: start;
		box-sizing: border-box;
		flex: 0 0 auto;
		min-block-size: 1.45rem;
		padding-block: 0.25rem;
	}

	.socket-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.socket {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.42rem;
		block-size: 1.45rem;
		min-inline-size: 0;
		/* padding: 0 0.52rem; */
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.68rem;
		cursor: crosshair;
	}

	.socket span:not(.pin) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: opacity 0.15s ease;
	}

	.graph-canvas[data-socket-labels="never"] .socket span:not(.pin) {
		opacity: 0;
	}

	.graph-canvas[data-socket-labels="hover"] .socket span:not(.pin) {
		opacity: 0;
	}

	.graph-canvas[data-socket-labels="hover"] .socket:hover span:not(.pin) {
		opacity: 1;
	}

	.socket.incompatible {
		opacity: 0.34;
		cursor: not-allowed;
	}

	.pin {
		box-sizing: border-box;
		inline-size: 0.5rem;
		block-size: 0.5rem;
		border: solid 0.05rem color-mix(in srgb, var(--socket-color) 70%, transparent);
		border-radius: 50%;
		background: var(--ga-node);
		box-shadow: 0 0 0 0.08rem rgb(0 0 0 / 0.32);
	}

	.socket:hover .pin,
	.socket.connected .pin {
		background: var(--socket-color);
	}

	.node-content {
		flex: 1 1 auto;
		min-block-size: 0;
		/* padding: 0.18rem 0.35rem 0.35rem; */
		/* overflow: auto; */
		user-select: text;
	}

	.resize-handle {
		position: absolute;
		inset-inline-end: 0.12rem;
		inset-block-end: 0.12rem;
		inline-size: 1rem;
		block-size: 1rem;
		padding: 0;
		border: 0;
		background: linear-gradient(
			135deg,
			transparent 0 52%,
			color-mix(in srgb, var(--ga-outline) 72%, transparent) 52% 60%,
			transparent 60% 68%,
			color-mix(in srgb, var(--ga-outline) 72%, transparent) 68% 76%,
			transparent 76%
		);
		cursor: nwse-resize;
	}

	.resize-handle:hover {
		background: linear-gradient(
			135deg,
			transparent 0 52%,
			color-mix(in srgb, var(--ga-selection) 88%, transparent) 52% 60%,
			transparent 60% 68%,
			color-mix(in srgb, var(--ga-selection) 88%, transparent) 68% 76%,
			transparent 76%
		);
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

	.toolbar button {
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

	.zoom-control {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding-inline-start: 0.2rem;
	}

	.zoom-slider {
		appearance: none;
		inline-size: 4.8rem;
		block-size: 0.16rem;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 999rem;
		background: color-mix(in srgb, var(--ga-outline) 42%, transparent);
		opacity: 0.62;
		cursor: pointer;
		transition: opacity 120ms ease;
	}

	.zoom-slider:hover,
	.zoom-slider:focus-visible {
		opacity: 1;
	}

	.zoom-slider::-webkit-slider-thumb {
		appearance: none;
		inline-size: 0.62rem;
		block-size: 0.62rem;
		border: solid 0.08rem color-mix(in srgb, var(--ga-bg) 70%, transparent);
		border-radius: 50%;
		background: var(--ga-outline);
	}

	.zoom-slider::-moz-range-thumb {
		inline-size: 0.52rem;
		block-size: 0.52rem;
		border: solid 0.08rem color-mix(in srgb, var(--ga-bg) 70%, transparent);
		border-radius: 50%;
		background: var(--ga-outline);
	}

	.toolbar .zoom-reset {
		min-inline-size: 3.15rem;
		padding-inline: 0.4rem;
		font-variant-numeric: tabular-nums;
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
