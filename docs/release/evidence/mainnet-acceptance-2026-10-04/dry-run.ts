import {runDryRun,mockFixture} from '../../../../apps/landing/scripts/dry-run-inscription';
const payload={filename:'input.png',contentType:'image/png',content:new Uint8Array(await Bun.file('docs/release/evidence/exact-revision-2026-10-03/input.png').arrayBuffer())};
const privateKey=new Uint8Array(32); privateKey[31]=1;
const report=await runDryRun({network:'mainnet',mode:'mock',payload,world:(contentBytes:number)=>mockFixture({network:'mainnet',privateKey,contentBytes}),webvhDomain:'originals.build'});
await Bun.write(process.env.DRY_RUN_RECEIPT ?? '/tmp/originals-mainnet-format-dry-run.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({verdict:report.verdict,checks:report.checks,signing:report.signing}));
process.exit(report.verdict==='pass'?0:1);
