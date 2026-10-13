/* Load the bundle in node with just enough browser to let it finish.
 *
 * check.py proves the bundle parses; this lets a test call the real
 * roomChips(), chipLook() and the rest instead of a copy pasted into the
 * test, which is the kind of copy that passes after the original has
 * changed. The bundle is an ES module only because of one import.meta.url,
 * so that is rewritten rather than the whole file being treated as one.
 *
 *   const { roomChips } = require("./tools/harness.js");
 */
// Enough of a browser for the bundle to finish loading, so the real
// roomChips() can be called instead of a re-typed copy of it.
const el = () => new Proxy({ style:{}, classList:{ add(){}, remove(){}, toggle(){} },
  children:[], shadowRoot:null, innerHTML:"", textContent:"" }, {
  get(t,k){ if(k in t) return t[k];
    return (...a)=>{ if(k==="attachShadow"){ t.shadowRoot=el(); return t.shadowRoot; } return el(); }; },
  set(t,k,v){ t[k]=v; return true; } });
global.HTMLElement = class {};
global.customElements = { _m:new Map(), define(n,c){this._m.set(n,c);}, get(n){return this._m.get(n);},
  whenDefined(){return Promise.resolve();} };
global.document = { createElement: el, querySelector: ()=>null, body: el(),
  head: el(), documentElement: el(), addEventListener(){}, createDocumentFragment: el };
global.window = { addEventListener(){}, removeEventListener(){}, loadCardHelpers: async()=>({}),
  matchMedia: ()=>({matches:false, addEventListener(){}}), location:{hash:"",href:""},
  history:{replaceState(){},pushState(){}}, localStorage:{getItem:()=>null,setItem(){}},
  devicePixelRatio:1, setTimeout, clearTimeout };
for (const k of ["location","history","localStorage","setTimeout","clearTimeout"]) global[k]=window[k];
global.CustomEvent = class { constructor(t,o){ this.type=t; Object.assign(this,o);} };
global.navigator = { clipboard:{ writeText: async()=>{} } };
global.fetch = async () => ({ ok:true, json: async()=>({}), text: async()=>"" });
const src = require("fs").readFileSync(require("path").join(__dirname, "..", "dist", "charro-cards.js"), "utf8");
// the bundle is a classic script; expose what the test needs
eval(src.replace(/import\.meta\.url/g, JSON.stringify("https://x/charro-cards.js")) + "\n;globalThis.__T = { roomChips, chipLook, chipCol, tileChips, roomBody, VIDEO_CSS,\n  CHIP_PAL, CHIP_SPECS, CHIP_OFF, CHIP_GROUPS, TILE_CHIPS };");
module.exports = globalThis.__T;
