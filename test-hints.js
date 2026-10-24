const vm=require("vm"),fs=require("fs");
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+"/songs.js","utf8")+";this.S=SONGS;",ctx);
const S=ctx.S;let bad=0;
const banned={beatles:/beatles|liverpool|abbey road|lennon|mccartney|harrison|ringo/i,bowie:/bowie|ziggy|major tom|hunky dory|thin white duke/i,gaga:/gaga|artpop|chromatica|born this way|the fame/i,talkingheads:/talking heads|byrne|stop making sense|remain in light|fear of music/i};
for(const s of S){
 if(!Array.isArray(s.hints)||s.hints.length!==3||s.hints.some(h=>!h||h.length<3||h.length>160)){console.log("BAD HINTS",s.title);bad++;continue}
 for(const p of s.packs||[]){const r=banned[p];if(r&&s.hints.some(h=>r.test(h))){console.log("LEAK",s.title,p);bad++}}
}
console.log(bad?"FAIL "+bad:"hints ok: "+S.length+" songs");process.exit(bad?1:0);
