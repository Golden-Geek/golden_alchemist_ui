export type GraphSocketDirection = 'input' | 'output';

export interface GraphSocket {
	id: string;
	label: string;
	valueType?: string;
	compatible?: boolean;
	color?: string;
}

export interface GraphNode {
	id: string;
	label: string;
	subtitle?: string;
	x: number;
	y: number;
	width?: number;
	inputs: GraphSocket[];
	outputs: GraphSocket[];
	active?: boolean;
	invalid?: boolean;
}

export interface GraphSocketRef {
	nodeId: string;
	socketId: string;
}

export interface GraphEdge {
	id?: string;
	from: GraphSocketRef;
	to: GraphSocketRef;
	active?: boolean;
	invalid?: boolean;
}

export interface GraphConnectionRequest {
	from: GraphSocketRef;
	to: GraphSocketRef;
}

export interface GraphNodePosition {
	x: number;
	y: number;
}

export interface GraphNodeMove {
	nodeId: string;
	position: GraphNodePosition;
}
