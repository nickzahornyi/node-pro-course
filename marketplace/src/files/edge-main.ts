import { createEdge } from './edge.js';
const edge=createEdge();
edge.listen(Number(process.env.EDGE_PORT || 22651),'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>edge.close());
