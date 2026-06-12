export interface GraphCamera {
	x: number;
	y: number;
	zoom: number;
}

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
	description?: string;
	canRename?: boolean;
	collapsed?: boolean;
	color?: string;
	socketPlacement?: 'body' | 'header';
	x: number;
	y: number;
	width?: number;
	height?: number;
	resizable?: boolean;
	inputs: GraphSocket[];
	outputs: GraphSocket[];
	headerInputs?: GraphSocket[];
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
	color?: string;
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

export interface GraphNodeSize {
	width: number;
	height: number;
}

export interface GraphNodeResize {
	nodeId: string;
	size: GraphNodeSize;
}

export interface GraphNodeCreationRequest {
	position: GraphNodePosition;
	clientX: number;
	clientY: number;
}
