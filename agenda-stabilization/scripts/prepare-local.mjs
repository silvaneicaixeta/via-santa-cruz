import {createReadStream,createWriteStream,chmodSync,existsSync,copyFileSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createBrotliDecompress} from "node:zlib";
import {pipeline} from "node:stream/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
process.chdir(root);mkdirSync(".local-browser",{recursive:true});
for(const name of ["chromium","fonts.tar","swiftshader.tar"]) {
 const target=".local-browser/"+name;
 if(!existsSync(target) || readFileSync(target).length===0)
  await pipeline(createReadStream("node_modules/@sparticuz/chromium/bin/"+name+".br"),
   createBrotliDecompress(),createWriteStream(target));
}
chmodSync(".local-browser/chromium",0o700);
for(const name of ["fonts.tar","swiftshader.tar"]){
 const r=spawnSync("tar",["--no-same-owner","-xf",".local-browser/"+name,"-C",".local-browser"],{stdio:"inherit"});
 if(r.status!==0)throw new Error("Local browser extraction failed");
}
for(const name of ["vsc-favicon-agenda.png","vsc-favicon.png","vsc-logo.png","agenda-apple-touch-icon.png",
 "agenda-icon-192.png","agenda-icon-512.png"]){
 const src=path.resolve("../agenda-app",name),dst="baseline/site16/"+name;
 if(existsSync(src) && !existsSync(dst))copyFileSync(src,dst);
}
// Pin existing Edge dependencies for offline validation using the same npm versions.
for(const name of ["vsc-agenda","vsc-agenda-admin-dashboard"]){
 const src=readFileSync("functions/"+name+"/index.ts","utf8");
 writeFileSync(".local-browser/"+name+"-check.ts",src.replace('import "jsr:@supabase/functions-js/edge-runtime.d.ts";','')
  .replace('from "npm:@supabase/supabase-js@2"','from "@supabase/supabase-js"'));
}
