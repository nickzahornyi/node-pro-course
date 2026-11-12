function integer(env,name,fallback,min,max) {
 const raw=env[name] ?? String(fallback),value=Number(raw);
 if(!raw.trim() || !Number.isSafeInteger(value) || value<min || value>max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
 return value;
}
export function loadConfig(env=process.env) {
 return {
  workers:integer(env,'LOAD_WORKERS',16,1,256),
  intervalMs:integer(env,'LOAD_INTERVAL_MS',0,0,60000),
  maxSeconds:integer(env,'LOAD_MAX_SECONDS',300,1,3600),
  baselineSeconds:integer(env,'LOAD_BASELINE_SECONDS',20,1,300),
 };
}
