export type AriaSnapshotNode = {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    backendDOMNodeId?: number;
    depth: number;
};
export type RawAXNode = {
    nodeId?: string;
    role?: {
        value?: string;
    };
    name?: {
        value?: string;
    };
    value?: {
        value?: string;
    };
    description?: {
        value?: string;
    };
    childIds?: string[];
    backendDOMNodeId?: number;
};
export declare function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[];
