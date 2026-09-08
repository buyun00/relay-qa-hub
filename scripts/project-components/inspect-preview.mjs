import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";
console.log(JSON.stringify(readParallelInstanceConfig(process.argv[2])));
