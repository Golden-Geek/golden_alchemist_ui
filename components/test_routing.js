const ROUTING_GRID_REM = 1;
const remPx = 16;
const ROUTING_TURN_COST = 0.35;
const ROUTING_MAX_VISITS = 24000;
const ROUTING_MARGIN_REM = 16;

const routingPointBlocked = (x, y) => false;
const routingStateKey = (x, y, direction) => `${x}:${y}:${direction}`;

const heapPush = (heap, state) => {
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

const heapPop = (heap) => {
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

const findOrthogonalRoute = (start, end) => {
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
    const open = [];
    const costs = new Map();
    const parents = new Map();
    const states = new Map();
    const startState = {
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
    let goal = null;
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
            const next = {
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
    if (!goal) return null;
    const points = [];
    let key = goal.key;
    while (key) {
        const state = states.get(key);
        if (!state) break;
        points.push({ x: state.x * grid, y: state.y * grid });
        key = parents.get(key);
    }
    points.reverse();
    return points;
};

const simplifyRoute = (points) => {
    const unique = points.filter(
        (point, index) =>
            index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
    );
    if (unique.length < 3) return unique;
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

const points = findOrthogonalRoute({x: 0, y: 0}, {x: 10*16, y: 5*16});
console.log(simplifyRoute(points));
