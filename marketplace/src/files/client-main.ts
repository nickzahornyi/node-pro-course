// This process receives capabilities through IPC, never storage credentials.
process.once('message',async (job:any)=>{
  try {
    if(job.resume) {
      const r=job.resume;
      const response=await fetch(r.base+'/uploads/resume',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${r.token}`},body:JSON.stringify({id:r.id})});
      if(response.status!==200) throw new Error(`Resume status ${response.status}`);
      const state:any=await response.json();
      job.parts=state.parts.map((p:any)=>({...p,size:Math.min(state.partSize,r.size-(p.number-1)*state.partSize)}));
    }
    let count=0;
    for(const part of job.parts) {
      const body=Buffer.alloc(part.size,part.fill || 97);
      const response=await fetch(part.url,{method:'PUT',headers:{'content-type':'application/octet-stream'},body,signal:AbortSignal.timeout(15000)});
      await response.arrayBuffer();
      if(response.status!==200) throw new Error(`PUT status ${response.status}`);
      count++;
      if(job.crashAfter===count) process.exit(17);
    }
    process.send?.({status:200,count});
    process.disconnect();
  } catch(e:any) {console.error(e.message);process.exit(1);}
});
