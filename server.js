require("dotenv").config();
const express=require("express"), session=require("express-session"), multer=require("multer");
const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,PermissionFlagsBits,ChannelType,ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
const fs=require("fs"), path=require("path");
const {Pool}=require("pg");
const app=express(), PORT=Number(process.env.PORT||3000), API="https://discord.com/api/v10";
const GUILD=process.env.DISCORD_GUILD_ID||"1492598542764867744";
const CATEGORY=process.env.TICKET_CATEGORY_ID||"1492658451413860462";
const CLIENT=process.env.DISCORD_CLIENT_ID||"1549512651007066253";
const SECRET=process.env.DISCORD_CLIENT_SECRET||"";
const REDIRECT=process.env.DISCORD_REDIRECT_URI||"http://localhost:3000/auth/discord/callback";
const BOT=process.env.DISCORD_BOT_TOKEN||"";
const ADMINS=(process.env.ADMIN_DISCORD_IDS||"1403030168808853636").split(",").map(x=>x.trim()).filter(Boolean);
const FORUMS={skiny:"1543052884625719398",mody:"1543052774508466236",citizeny:"1543052943140323438"};
const ROOT=__dirname, DATA=path.join(ROOT,"data"), UP=path.join(ROOT,"uploads");
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(UP,{recursive:true});
const ORD=path.join(DATA,"orders.json"), CONTENT=path.join(DATA,"content.json"), STATS=path.join(DATA,"stats.json");
const defaults={site:{about:"Premium FiveM assets & custom work.",contact:"Skontaktuj się przez Discord.",discordInvite:""},products:[{id:"custom-skin",name:"Custom Skin",price:7},{id:"custom-koszulka",name:"Custom Koszulka",price:14}],media:{tiktok:[],youtube:[]},faq:[],changelog:[],catalog:FORUMS};
if(!fs.existsSync(ORD))fs.writeFileSync(ORD,"[]");
if(!fs.existsSync(CONTENT))fs.writeFileSync(CONTENT,JSON.stringify(defaults,null,2));
if(!fs.existsSync(STATS))fs.writeFileSync(STATS,JSON.stringify({pageViews:0,visitors:[],daily:{}},null,2));
// Persistent storage: PostgreSQL when DATABASE_URL is configured, local JSON as fallback/cache.
const dbCache=new Map();
let dbPool=null, dbReady=false;
const dbKey=f=>path.basename(f).toLowerCase();
const read=(f,d)=>{
 const k=dbKey(f);
 if(dbCache.has(k))return dbCache.get(k);
 try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return d}
};
const persistDb=(k,v)=>{
 if(!dbReady||!dbPool)return;
 dbPool.query(`INSERT INTO vanta_store(key,data,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,[k,JSON.stringify(v)])
   .catch(e=>console.error("[VANTA DB WRITE]",k,e.message));
};
const write=(f,v)=>{
 const k=dbKey(f); dbCache.set(k,v);
 try{fs.writeFileSync(f,JSON.stringify(v,null,2))}catch(e){console.error("[VANTA LOCAL WRITE]",e.message)}
 persistDb(k,v);
};
async function initPersistentStore(){
 const url=String(process.env.DATABASE_URL||"").trim();
 if(!url){console.warn("[VANTA DB] Brak DATABASE_URL — dane działają lokalnie, ale nie są trwałe po redeployu.");return}
 try{
  dbPool=new Pool({connectionString:url,ssl:process.env.DB_SSL==="false"?false:{rejectUnauthorized:false}});
  await dbPool.query(`CREATE TABLE IF NOT EXISTS vanta_store (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const files=[ORD,CONTENT,STATS,path.join(DATA,"v25.json")];
  for(const f of files){
   const k=dbKey(f),r=await dbPool.query(`SELECT data FROM vanta_store WHERE key=$1`,[k]);
   if(r.rows.length){dbCache.set(k,r.rows[0].data);try{fs.writeFileSync(f,JSON.stringify(r.rows[0].data,null,2))}catch{}}
   else{let local;try{local=JSON.parse(fs.readFileSync(f,"utf8"))}catch{local=k==="orders.json"?[]:{}};dbCache.set(k,local);await dbPool.query(`INSERT INTO vanta_store(key,data) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`,[k,JSON.stringify(local)])}
  }
  dbReady=true; console.log("[VANTA DB] PostgreSQL ONLINE — dane trwałe.");
 }catch(e){console.error("[VANTA DB] Błąd połączenia:",e.message);dbPool=null;dbReady=false}
}
const upload=multer({dest:UP,limits:{fileSize:15*1024*1024,files:10}});
app.use(express.json({limit:"2mb"}));
app.set("trust proxy",1);
app.use(session({secret:process.env.SESSION_SECRET||"CHANGE_THIS_SESSION_SECRET",resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:"auto",sameSite:"lax",maxAge:7*864e5}}));
app.get("/vanta-logo.png",(q,s)=>s.sendFile(path.join(ROOT,"vanta-logo.png")));

async function discord(url,opt={}){
 if(!BOT)throw Error("Brak DISCORD_BOT_TOKEN w .env");
 const headers={Authorization:`Bot ${BOT}`,...(opt.headers||{})};
 if(opt.body && !(opt.body instanceof FormData) && !headers["Content-Type"])headers["Content-Type"]="application/json";
 const r=await fetch(API+url,{...opt,headers}); const txt=await r.text(); let b;
 try{b=txt?JSON.parse(txt):{}}catch{b=txt}
 if(!r.ok)throw Error(`Discord ${r.status}: ${typeof b==="string"?b:JSON.stringify(b)}`);
 return b;
}
const admin=q=>!!q.session.user&&ADMINS.includes(String(q.session.user.id));
const needLogin=(q,s,n)=>q.session.user?n():s.status(401).json({error:"Zaloguj się przez Discord."});
const needAdmin=(q,s,n)=>admin(q)?n():s.status(403).json({error:"Brak uprawnień administratora."});

app.use((q,s,n)=>{
 if(q.path==="/"){let st=read(STATS,{pageViews:0,visitors:[],daily:{}}); if(!Array.isArray(st.visitors))st.visitors=[]; if(!st.daily)st.daily={};
 st.pageViews=Number(st.pageViews||0)+1; const key=new Date().toISOString().slice(0,10); st.daily[key]=Number(st.daily[key]||0)+1;
 const v=q.sessionID; if(v&&!st.visitors.includes(v))st.visitors.push(v); write(STATS,st)}
 n();
});

app.get("/auth/discord",(q,s)=>{
 if(!CLIENT)return s.status(500).send("Brak DISCORD_CLIENT_ID w lokalnym .env.");
 const p=new URLSearchParams({client_id:CLIENT,redirect_uri:REDIRECT,response_type:"code",scope:"identify",prompt:"consent"});
 return s.redirect(302,"https://discord.com/oauth2/authorize?"+p.toString());
});
app.get("/api/oauth/status",(q,s)=>s.json({
 ok:!!CLIENT,
 clientConfigured:!!CLIENT,
 secretConfigured:!!SECRET,
 redirectUri:REDIRECT
}));
app.get("/auth/discord/callback",async(q,s)=>{
 try{
  if(!SECRET)return s.status(500).send("Brak DISCORD_CLIENT_SECRET w lokalnym .env. Ustaw aktualny sekret aplikacji Discord i uruchom serwer ponownie.");
  if(!q.query.code)throw Error("Discord nie zwrócił kodu autoryzacji.");
  const p=new URLSearchParams({client_id:CLIENT,client_secret:SECRET,grant_type:"authorization_code",code:q.query.code,redirect_uri:REDIRECT});
  let r=await fetch(API+"/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:p});
  let t=await r.json().catch(()=>({}));
  if(!r.ok){
   console.error("[VANTA OAuth]",r.status,t);
   return s.status(401).send(`<!doctype html><meta charset="utf-8"><style>body{background:#050506;color:#fff;font:16px Arial;display:grid;place-items:center;min-height:100vh}.x{max-width:620px;padding:30px;border:1px solid #29292f;border-radius:18px;background:#0b0b0e}a{display:inline-block;margin-top:15px;background:#fff;color:#000;padding:12px 16px;border-radius:9px;text-decoration:none;font-weight:800}</style><div class=x><h2>Discord OAuth — błąd logowania</h2><p>Discord odrzucił konfigurację aplikacji. Jeśli widzisz <b>invalid_client</b>, zaktualizuj DISCORD_CLIENT_SECRET w lokalnym .env i uruchom Node ponownie.</p><p>Redirect URI musi być dokładnie: <b>${REDIRECT}</b></p><a href="/">WRÓĆ DO VANTA HUB</a></div>`);
  }
  r=await fetch(API+"/users/@me",{headers:{Authorization:"Bearer "+t.access_token}}); const u=await r.json();
  if(!r.ok)throw Error("Nie udało się pobrać profilu Discord.");
  q.session.user={id:u.id,username:u.username,global_name:u.global_name||u.username,avatar:u.avatar||null,discriminator:u.discriminator||null}; q.session.justLoggedIn=true;
  s.redirect("/");
 }catch(e){console.error("[VANTA OAuth]",e);s.status(500).send("Błąd logowania Discord. Wróć na stronę główną i spróbuj ponownie.");}
});
app.get("/api/me",(q,s)=>{const j=!!q.session.justLoggedIn;q.session.justLoggedIn=false;s.json({loggedIn:!!q.session.user,user:q.session.user||null,admin:admin(q),justLoggedIn:j})});
app.get("/api/site",(q,s)=>{const c={...defaults,...read(CONTENT,{})};c.catalog={...FORUMS,...(c.catalog||{})};c.realizations=Array.isArray(c.realizations)?c.realizations:[];c.reviews=Array.isArray(c.reviews)?c.reviews:[];c.announcement=c.announcement||{enabled:false,text:""};s.json(c)});

app.get("/api/admin/media/preview",needAdmin,async(q,s)=>{
 try{
  const url=String(q.query.url||"").trim(); if(!/^https?:\/\//i.test(url))return s.status(400).json({error:"Nieprawidłowy link."});
  let thumbnail="";
  const yt=url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([A-Za-z0-9_-]{6,})/i);
  if(yt)thumbnail=`https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;
  else if(/tiktok\.com/i.test(url)){const r=await fetch("https://www.tiktok.com/oembed?url="+encodeURIComponent(url),{headers:{"User-Agent":"Mozilla/5.0 VANTA-HUB"}});if(r.ok){const x=await r.json();thumbnail=String(x.thumbnail_url||"")}}
  s.json({ok:true,thumbnail});
 }catch(e){s.json({ok:true,thumbnail:""})}
});

async function forumThreads(fid){
 const all=[]; try{const a=await discord(`/guilds/${GUILD}/threads/active`);all.push(...(a.threads||[]))}catch{}
 try{const a=await discord(`/channels/${fid}/threads/archived/public?limit=100`);all.push(...(a.threads||[]))}catch{}
 const uniq=[...new Map(all.filter(x=>String(x.parent_id)===String(fid)).map(x=>[x.id,x])).values()];
 return uniq;
}
app.get("/api/catalog/:type",async(q,s)=>{
 try{
  const c=read(CONTENT,defaults), fid=(c.catalog||{})[q.params.type]||FORUMS[q.params.type]; if(!fid)return s.status(404).json({error:"Nieznana kategoria."});
  const threads=await forumThreads(fid), result=[];
  for(const th of threads){
   let starter=null; try{starter=await discord(`/channels/${th.id}/messages/${th.id}`)}catch{}
   result.push({id:th.id,name:th.name,content:starter?.content||"",messageCount:th.message_count||0,attachments:starter?.attachments||[]});
  }
  s.json(result);
 }catch(e){console.error("[CATALOG]",e);s.status(500).json({error:e.message})}
});

function extractImages(m){
 const out=[],seen=new Set(); const add=(u,n="skin")=>{if(!u||seen.has(u)||/megawrzuta\.pl/i.test(u))return;if(/cdn\.discordapp\.com|media\.discordapp\.net|\.(png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(u)){seen.add(u);out.push({url:u,filename:n})}};
 for(const a of m.attachments||[])add(a.proxy_url||a.url,a.filename||"skin");
 for(const e of m.embeds||[])if(!/megawrzuta/i.test(`${e.url||""} ${e.provider?.name||""}`)){add(e.image?.proxy_url||e.image?.url);add(e.thumbnail?.proxy_url||e.thumbnail?.url)}
 function scan(v,k=""){if(v==null)return;if(Array.isArray(v)){v.forEach(x=>scan(x,k));return}if(typeof v==="object"){Object.entries(v).forEach(([kk,vv])=>scan(vv,kk));return}if(typeof v==="string"&&/^https?:\/\//i.test(v)&&/^(url|proxy_url|src)$/i.test(k))add(v)}
 scan(m.components||[]); return out;
}
function extractLinks(m){
 const out=[],rx=/https?:\/\/[^\s<>"']+/gi;
 for(const u of (m.content||"").match(rx)||[])if(/megawrzuta\.pl/i.test(u))out.push({url:u.replace(/[),.;]+$/,""),title:""});
 for(const e of m.embeds||[])if(/megawrzuta/i.test(`${e.url||""} ${e.provider?.name||""} ${e.title||""}`)&&e.url)out.push({url:e.url,title:e.title||""});
 function scan(v){if(v==null)return;if(Array.isArray(v)){v.forEach(scan);return}if(typeof v==="object"){if(typeof v.url==="string"&&/megawrzuta\.pl/i.test(v.url))out.push({url:v.url,title:v.label||v.title||""});Object.values(v).forEach(scan)}}
 scan(m.components||[]); return [...new Map(out.map(x=>[x.url,x])).values()];
}
app.get("/api/catalog/post/:id",async(q,s)=>{
 try{
  const ch=await discord(`/channels/${q.params.id}`); const c=read(CONTENT,defaults); const allowed=new Set(Object.values({...FORUMS,...(c.catalog||{})}).map(String));
  if(!allowed.has(String(ch.parent_id)))return s.status(403).json({error:"Ten post nie należy do katalogu VANTA."});
  let msgs=[],before="";
  for(let i=0;i<4;i++){const a=await discord(`/channels/${ch.id}/messages?limit=100${before?`&before=${before}`:""}`);msgs.push(...a);if(a.length<100)break;before=a[a.length-1].id}
  msgs.reverse();
  const products=[]; let pending=null;
  for(const m of msgs){
   const links=extractLinks(m),imgs=extractImages(m);
   if(links.length){for(const l of links){const p={messageId:m.id,url:l.url,title:l.title||"Pobierz skin",image:imgs.shift()?.url||null};products.push(p);pending=p.image?null:p}}
   else if(pending&&imgs.length){pending.image=imgs[0].url;pending=null}
  }
  console.log(`[VANTA] ${ch.name}: ${msgs.length} wiadomości, ${products.length} kart`);
  s.json({id:ch.id,name:ch.name,products});
 }catch(e){console.error("[POST]",e);s.status(500).json({error:e.message})}
});

app.get("/api/orders",(q,s)=>{if(!q.session.user)return s.status(401).json({error:"Zaloguj się przez Discord."});s.json(read(ORD,[]).filter(x=>x.userId===q.session.user.id))});

function normalizeDiscountCode(v){return String(v||"").trim().toUpperCase().replace(/\s+/g,"")}
function discountResult(code,basePrice,productId){
 const x=v25(), now=Date.now(), c=normalizeDiscountCode(code);
 if(!c)return {ok:false,error:"Wpisz kod rabatowy."};
 const d=(x.discounts||[]).find(z=>normalizeDiscountCode(z.code)===c);
 if(!d||d.active===false)return {ok:false,error:"Nieprawidłowy lub nieaktywny kod rabatowy."};
 if(d.expiresAt){
   const exp=Date.parse(d.expiresAt);
   if(Number.isFinite(exp)&&exp<now)return {ok:false,error:"Ten kod rabatowy wygasł."};
 }
 if(Array.isArray(d.products)&&d.products.length&&!d.products.includes(productId))
   return {ok:false,error:"Ten kod nie działa dla tego produktu."};
 const base=Math.max(0,Number(basePrice)||0);
 let discount=0;
 if(d.type==="fixed")discount=Math.max(0,Number(d.value)||0);
 else discount=base*Math.max(0,Math.min(100,Number(d.value)||0))/100;
 discount=Math.min(base,discount);
 const finalPrice=Math.max(0,Math.round((base-discount)*100)/100);
 return {ok:true,code:c,type:d.type==="fixed"?"fixed":"percent",value:Number(d.value)||0,basePrice:base,discount:Math.round(discount*100)/100,finalPrice};
}
app.post("/api/discount/validate",(q,res)=>{
 const c=read(CONTENT,defaults),p=(c.products||defaults.products).find(x=>x.id===q.body.product);
 if(!p)return res.status(400).json({error:"Nieprawidłowy produkt."});
 const r=discountResult(q.body.code,p.price,p.id);
 if(!r.ok)return res.status(400).json({error:r.error});
 res.json(r);
});

app.post("/api/orders",upload.array("files",10),async(q,s)=>{
 const files=q.files||[]; try{
  if(!q.session.user)return s.status(401).json({error:"Zaloguj się przez Discord."});
  const c=read(CONTENT,defaults),p=(c.products||defaults.products).find(x=>x.id===q.body.product);if(!p)throw Error("Nieprawidłowy produkt.");if(!q.body.description?.trim())throw Error("Wpisz opis zamówienia.");
  const discount=q.body.discountCode?.trim()?discountResult(q.body.discountCode,p.price,p.id):null;
  if(q.body.discountCode?.trim()&&!discount?.ok)throw Error(discount?.error||"Nieprawidłowy kod rabatowy.");
  const orderPrice=discount?.ok?discount.finalPrice:Number(p.price);
  if(!CATEGORY)throw Error("Brak TICKET_CATEGORY_ID w .env.");
  const parent=await discord(`/channels/${CATEGORY}`);
  if(Number(parent.type)!==4)throw Error("TICKET_CATEGORY_ID musi wskazywać kategorię Discord, a nie zwykły kanał.");
  if(String(parent.guild_id)!==String(GUILD))throw Error("Kategoria ticketów znajduje się na innym serwerze.");

  const id="VANTA-"+Date.now().toString(36).toUpperCase(), shortId=id.slice(-6);
  const overwrites=[{id:GUILD,type:0,deny:"1024"},{id:q.session.user.id,type:1,allow:"117760"}];
  for(const a of ADMINS)overwrites.push({id:a,type:1,allow:"117760"});
  const ch=await discord(`/guilds/${GUILD}/channels`,{method:"POST",body:JSON.stringify({
    name:"zamowienie-"+shortId.toLowerCase(),type:0,parent_id:CATEGORY,
    topic:`VANTA HUB | ${p.name} | ${q.session.user.global_name||q.session.user.username} | ${shortId}`,
    permission_overwrites:overwrites
  })});
  const o={id,shortId,product:p.name,price:p.price,finalPrice:orderPrice,discountCode:discount?.ok?discount.code:"",discountAmount:discount?.ok?discount.discount:0,description:q.body.description,status:"pending",userId:q.session.user.id,username:q.session.user.global_name||q.session.user.username,ticketChannelId:ch.id,createdAt:new Date().toISOString()};
  const a=read(ORD,[]);a.push(o);write(ORD,a);
  const ticketMessage=await discord(`/channels/${ch.id}/messages`,{method:"POST",body:JSON.stringify({
    content:`<@${q.session.user.id}>`,
    embeds:[{
      title:"VANTA HUB • ZAMÓWIENIE",
      description:"Dziękujemy za zamówienie. Tutaj ustalimy szczegóły projektu, wycenę oraz realizację.",
      fields:[
        {name:"ID",value:shortId,inline:true},
        {name:"Produkt",value:String(p.name),inline:true},
        {name:"Cena bazowa",value:String(p.price)+" PLN",inline:true},
        ...(discount?.ok?[{name:"Kod rabatowy",value:`${discount.code} • -${discount.discount} PLN`,inline:true},{name:"Cena po rabacie",value:`${orderPrice} PLN`,inline:true}]:[]),
        {name:"Klient",value:`<@${q.session.user.id}>`,inline:false},
        {name:"Opis projektu",value:String(q.body.description).slice(0,1024),inline:false},
        {name:"Status",value:"🟡 Oczekuje",inline:true}
      ],
      footer:{text:"VANTA HUB • System Zamówień"},
      timestamp:new Date().toISOString()
    }],
    components:[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("vanta_claim").setLabel("PRZEJMIJ").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("vanta_progress").setLabel("W REALIZACJI").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("vanta_done").setLabel("GOTOWE").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("vanta_close").setLabel("ZAMKNIJ").setStyle(ButtonStyle.Danger)
    ).toJSON()]
  })});
  o.ticketMessageId=ticketMessage.id;
  write(ORD,a);
  for(const f of files){const fd=new FormData();fd.append("payload_json",JSON.stringify({content:"Plik klienta: "+f.originalname}));fd.append("files[0]",new Blob([fs.readFileSync(f.path)]),f.originalname);await fetch(API+`/channels/${ch.id}/messages`,{method:"POST",headers:{Authorization:`Bot ${BOT}`},body:fd});try{fs.unlinkSync(f.path)}catch{}}
  s.json({ok:true,shortId,order:o});
 }catch(e){
  files.forEach(f=>{try{fs.unlinkSync(f.path)}catch{}});
  console.error("[VANTA TICKET]",e.message);
  let msg=e.message;
  if(/CHANNEL_PARENT_INVALID|parent_id/i.test(msg))msg="Nieprawidłowa kategoria ticketów. TICKET_CATEGORY_ID musi być ID kategorii Discord.";
  if(/Missing Permissions|50013/i.test(msg))msg="VANTA BOT nie ma uprawnień do tworzenia kanałów w kategorii ticketów.";
  s.status(500).json({error:msg})
 }
});

app.get("/api/admin/content",needAdmin,(q,s)=>s.json({...defaults,...read(CONTENT,{})}));
app.put("/api/admin/content",needAdmin,(q,s)=>{const c={...defaults,...q.body};write(CONTENT,c);s.json({ok:true,content:c})});
app.get("/api/admin/orders",needAdmin,(q,s)=>s.json(read(ORD,[])));
app.patch("/api/admin/orders/:id/status",needAdmin,async(q,s)=>{
 const ok=new Set(["pending","in_progress","done","closed"]);
 if(!ok.has(q.body.status))return s.status(400).json({error:"Nieprawidłowy status."});
 const a=read(ORD,[]),o=a.find(x=>x.id===q.params.id);
 if(!o)return s.status(404).json({error:"Nie znaleziono zamówienia."});
 o.status=q.body.status;o.updatedAt=new Date().toISOString();write(ORD,a);
 const labels={pending:"🟡 Oczekuje",in_progress:"🔵 W realizacji",done:"🟢 Gotowe",closed:"⚫ Zamknięte"};
 try{
   if(o.ticketChannelId&&o.ticketMessageId){
     const current=await discord(`/channels/${o.ticketChannelId}/messages/${o.ticketMessageId}`);
     const embed=(current.embeds&&current.embeds[0])||{};
     const fields=Array.isArray(embed.fields)?embed.fields.filter(f=>f.name!=="Status"):[];
     fields.push({name:"Status",value:labels[o.status],inline:true});
     await discord(`/channels/${o.ticketChannelId}/messages/${o.ticketMessageId}`,{method:"PATCH",body:JSON.stringify({
       content:current.content||`<@${o.userId}>`,
       embeds:[{title:"VANTA HUB • ZAMÓWIENIE",description:embed.description||"Dziękujemy za zamówienie. Tutaj ustalimy szczegóły projektu, wycenę oraz realizację.",fields,footer:{text:"VANTA HUB • Ticket System"},timestamp:embed.timestamp||o.createdAt}]
     })});
   }
 }catch(e){console.error("[VANTA STATUS SYNC]",e.message)}
 s.json({ok:true,order:o,statusLabel:labels[o.status]});
});
app.get("/api/admin/stats",needAdmin,(q,s)=>{const st=read(STATS,{pageViews:0,visitors:[],daily:{}}),a=read(ORD,[]),today=new Date().toISOString().slice(0,10);s.json({pageViews:Number(st.pageViews||0),uniqueVisitors:Array.isArray(st.visitors)?st.visitors.length:0,todayViews:Number(st.daily?.[today]||0),totalOrders:a.length,pending:a.filter(x=>x.status==="pending").length,inProgress:a.filter(x=>x.status==="in_progress").length,done:a.filter(x=>x.status==="done").length,closed:a.filter(x=>x.status==="closed").length})});


// ===== VANTA OWNER CONTROL CENTER =====
app.get("/api/admin/health",needAdmin,async(q,s)=>{
  const x={bot:false,guild:false,ticketCategory:false,ticketCategoryName:""};
  try{x.bot=!!(await discord("/users/@me")).id}catch{}
  try{x.guild=!!(await discord(`/guilds/${GUILD}`)).id}catch{}
  try{const c=await discord(`/channels/${CATEGORY}`);x.ticketCategory=Number(c.type)===4;x.ticketCategoryName=c.name||""}catch{}
  s.json(x);
});
app.get("/api/admin/users",needAdmin,(q,s)=>{
  const a=read(ORD,[]),m=new Map();
  for(const o of a){if(!m.has(o.userId))m.set(o.userId,{userId:o.userId,username:o.username||"Discord user",orders:0,total:0,lastOrder:""});const u=m.get(o.userId);u.orders++;u.total+=Number(o.price||0);if(!u.lastOrder||o.createdAt>u.lastOrder)u.lastOrder=o.createdAt}
  s.json([...m.values()].sort((a,b)=>String(b.lastOrder).localeCompare(String(a.lastOrder))));
});
app.post("/api/admin/orders/:id/message",needAdmin,async(q,s)=>{
  try{const a=read(ORD,[]),o=a.find(x=>x.id===q.params.id);if(!o)return s.status(404).json({error:"Nie znaleziono zamówienia."});const text=String(q.body.message||"").trim();if(!text)return s.status(400).json({error:"Wpisz wiadomość."});await discord(`/channels/${o.ticketChannelId}/messages`,{method:"POST",body:JSON.stringify({content:`**VANTA HUB • WIADOMOŚĆ OD OBSŁUGI**\n${text}`})});s.json({ok:true})}catch(e){s.status(500).json({error:e.message})}
});
app.post("/api/admin/orders/:id/close",needAdmin,async(q,s)=>{
  try{const a=read(ORD,[]),o=a.find(x=>x.id===q.params.id);if(!o)return s.status(404).json({error:"Nie znaleziono zamówienia."});await discord(`/channels/${o.ticketChannelId}`,{method:"PATCH",body:JSON.stringify({name:`closed-${o.shortId||o.id.slice(-6)}`})});o.status="closed";o.closedAt=new Date().toISOString();write(ORD,a);s.json({ok:true,order:o})}catch(e){s.status(500).json({error:e.message})}
});
app.delete("/api/admin/orders/:id",needAdmin,(q,s)=>{const a=read(ORD,[]),i=a.findIndex(x=>x.id===q.params.id);if(i<0)return s.status(404).json({error:"Nie znaleziono zamówienia."});a.splice(i,1);write(ORD,a);s.json({ok:true})});


app.post("/api/admin/broadcast",needAdmin,async(q,s)=>{
 try{const text=String(q.body.message||"").trim();if(!text)return s.status(400).json({error:"Wpisz wiadomość."});const a=read(ORD,[]).filter(o=>o.ticketChannelId&&o.status!=="closed");let sent=0,failed=0;for(const o of a){try{await discord(`/channels/${o.ticketChannelId}/messages`,{method:"POST",body:JSON.stringify({content:`**VANTA HUB • OGŁOSZENIE**\n${text}`})});sent++}catch{failed++}}s.json({ok:true,sent,failed})}catch(e){s.status(500).json({error:e.message})}
});
app.get("/api/admin/export",needAdmin,(q,s)=>s.json({exportedAt:new Date().toISOString(),content:read(CONTENT,defaults),orders:read(ORD,[]),stats:read(STATS,{})}));


// ===== VANTA CHANGELOG SYNC =====
// Channel ID is stored in data/content.json through Owner Panel; no .env edit required.
app.get("/api/changelog/sync",async(q,res)=>{
 try{
   const c=read(CONTENT,defaults), channelId=String(c.changelogDiscordChannelId||"").trim();
   if(!channelId)return res.json({ok:true,configured:false,items:c.changelog||[]});
   const msgs=await discord(`/channels/${channelId}/messages?limit=30`);
   const discordItems=(Array.isArray(msgs)?msgs:[])
     .filter(m=>!m.author?.bot && String(m.content||"").trim())
     .map(m=>({id:`discord-${m.id}`,title:"DISCORD UPDATE",text:String(m.content).trim(),date:m.timestamp,source:"discord"}))
     .reverse();
   const manual=(Array.isArray(c.changelog)?c.changelog:[]).filter(x=>x.source!=="discord");
   c.changelog=[...manual,...discordItems].slice(-60);
   write(CONTENT,c);
   res.json({ok:true,configured:true,items:c.changelog});
 }catch(e){console.error("[VANTA CHANGELOG SYNC]",e.message);res.status(500).json({error:e.message})}
});
app.post("/api/admin/changelog/publish",needAdmin,async(q,res)=>{
 try{
   const title=String(q.body.title||"").trim(),text=String(q.body.text||"").trim();
   if(!title||!text)return res.status(400).json({error:"Wpisz tytuł i treść changelogu."});
   const c=read(CONTENT,defaults), item={id:`site-${Date.now()}`,title,text,date:new Date().toISOString(),source:"site"};
   c.changelog=Array.isArray(c.changelog)?c.changelog:[];c.changelog.push(item);c.changelog=c.changelog.slice(-60);write(CONTENT,c);
   const channelId=String(c.changelogDiscordChannelId||"").trim();
   let discordSent=false;
   if(channelId){
     await discord(`/channels/${channelId}/messages`,{method:"POST",body:JSON.stringify({
       embeds:[{title:`VANTA HUB • ${title}`,description:text.slice(0,4000),footer:{text:"VANTA HUB • Changelog"},timestamp:item.date}]
     })});
     discordSent=true;
   }
   res.json({ok:true,item,discordSent});
 }catch(e){console.error("[VANTA CHANGELOG PUBLISH]",e.message);res.status(500).json({error:e.message})}
});
app.put("/api/admin/changelog/settings",needAdmin,(q,res)=>{
 const c=read(CONTENT,defaults);c.changelogDiscordChannelId=String(q.body.channelId||"").trim();write(CONTENT,c);res.json({ok:true,channelId:c.changelogDiscordChannelId});
});


// ===== VANTA MEGA V25 =====
const V25=path.join(DATA,"v25.json");
const v25Default={favorites:{},views:{},downloads:{},notifications:{},notes:{},priority:{},deadlines:{},finalPrice:{},history:{},blacklist:[],assignments:{},staff:[],tags:{},discounts:[],promotions:[],activity:[],settings:{maintenance:false,announcementType:"info",announcementFrom:"",announcementTo:"",sectionOrder:["offer","v18Realizacje","media","v18Reviews","changelog","faq","contact"]}};
function v25(){const x=read(V25,v25Default);return {...v25Default,...x,settings:{...v25Default.settings,...(x.settings||{})}}}
function save25(x){write(V25,x)}
function act(type,text,user="system"){const x=v25();x.activity.unshift({id:Date.now().toString(36),type,text,user,at:new Date().toISOString()});x.activity=x.activity.slice(0,250);save25(x)}
app.get("/api/v25/public",(q,res)=>{const x=v25(),orders=read(ORD,[]);res.json({views:x.views,downloads:x.downloads,tags:x.tags,discounts:x.discounts,promotions:x.promotions,maintenance:x.settings.maintenance,sectionOrder:x.settings.sectionOrder,stats:{orders:orders.length,products:Object.keys(x.views).length,completed:orders.filter(o=>o.status==="done"||o.status==="closed").length}})});
app.post("/api/v25/view",(q,res)=>{const id=String(q.body.id||"");if(id){const x=v25();x.views[id]=(x.views[id]||0)+1;save25(x)}res.json({ok:true})});
app.post("/api/v25/download",(q,res)=>{const id=String(q.body.id||"");if(id){const x=v25();x.downloads[id]=(x.downloads[id]||0)+1;save25(x)}res.json({ok:true})});
app.get("/api/v25/me",needLogin,(q,res)=>{const x=v25(),uid=q.session.user.id,orders=read(ORD,[]).filter(o=>o.userId===uid);res.json({favorites:x.favorites[uid]||[],notifications:x.notifications[uid]||[],orders})});
app.put("/api/v25/favorites/:id",needLogin,(q,res)=>{const x=v25(),uid=q.session.user.id,a=x.favorites[uid]||[];const i=a.indexOf(q.params.id);if(i>=0)a.splice(i,1);else a.push(q.params.id);x.favorites[uid]=a;save25(x);res.json({ok:true,favorites:a})});
app.get("/api/admin/v25",needAdmin,(q,res)=>res.json(v25()));
app.put("/api/admin/v25/settings",needAdmin,(q,res)=>{const x=v25();x.settings={...x.settings,...q.body};save25(x);act("settings","Zmieniono ustawienia strony",q.session.user.username);res.json({ok:true,settings:x.settings})});
app.put("/api/admin/v25/order/:id",needAdmin,(q,res)=>{const x=v25(),id=q.params.id;for(const k of ["notes","priority","deadlines","finalPrice","assignments"])if(k in q.body)x[k][id]=q.body[k];x.history[id]=x.history[id]||[];x.history[id].push({at:new Date().toISOString(),by:q.session.user.username,change:q.body});save25(x);act("order",`Zaktualizowano ${id}`,q.session.user.username);res.json({ok:true})});
app.post("/api/admin/v25/blacklist/:uid",needAdmin,(q,res)=>{const x=v25(),id=q.params.uid,i=x.blacklist.indexOf(id);if(i>=0)x.blacklist.splice(i,1);else x.blacklist.push(id);save25(x);res.json({ok:true,blacklist:x.blacklist})});
app.put("/api/admin/v25/catalog",needAdmin,(q,res)=>{const x=v25();for(const k of ["tags","discounts","promotions"])if(k in q.body)x[k]=q.body[k];save25(x);res.json({ok:true})});
app.get("/api/admin/v25/export.csv",needAdmin,(q,res)=>{const a=read(ORD,[]);const esc=x=>`"${String(x??"").replace(/"/g,'""')}"`;const rows=[["ID","Klient","Discord ID","Produkt","Cena bazowa","Status","Data"],...a.map(o=>[o.id,o.username,o.userId,o.product,o.price,o.status,o.createdAt])];res.type("text/csv").send(rows.map(r=>r.map(esc).join(",")).join("\n"))});
app.post("/api/admin/v25/test-ticket",needAdmin,async(q,res)=>{try{const parent=await discord(`/channels/${CATEGORY}`);res.json({ok:Number(parent.type)===4,name:parent.name})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/admin/v25/test-changelog",needAdmin,async(q,res)=>{try{const c=read(CONTENT,defaults),id=String(c.changelogDiscordChannelId||"");if(!id)return res.status(400).json({error:"Najpierw ustaw kanał changelogu."});await discord(`/channels/${id}/messages`,{method:"POST",body:JSON.stringify({content:"**VANTA HUB • TEST**\nSynchronizacja changelogu działa poprawnie."})});res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.get("/",(q,s)=>s.sendFile(path.join(ROOT,"index.html")));

// ===== VANTA FULL V26: completed workflows =====
const BACKUPS=path.join(DATA,"backups");fs.mkdirSync(BACKUPS,{recursive:true});
function isStaff(q){const x=v25();return admin(q)||x.staff.some(s=>String(typeof s==='string'?s:s.id)===String(q.session.user?.id))}
const needStaff=(q,s,n)=>isStaff(q)?n():s.status(403).json({error:"Brak uprawnień pracownika."});
function notify(uid,text,type="info"){const x=v25();x.notifications[uid]=x.notifications[uid]||[];x.notifications[uid].unshift({id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),text,type,read:false,at:new Date().toISOString()});x.notifications[uid]=x.notifications[uid].slice(0,80);save25(x)}
async function dm(uid,text){const ch=await discord('/users/@me/channels',{method:'POST',body:JSON.stringify({recipient_id:String(uid)})});return discord(`/channels/${ch.id}/messages`,{method:'POST',body:JSON.stringify({content:text})})}
app.post('/api/v26/notifications/read',needLogin,(q,res)=>{const x=v25(),a=x.notifications[q.session.user.id]||[];a.forEach(n=>n.read=true);save25(x);res.json({ok:true})});
app.get('/api/v26/queue',needLogin,(q,res)=>{const a=read(ORD,[]).filter(o=>!['done','closed'].includes(o.status));const mine=a.findIndex(o=>o.userId===q.session.user.id);res.json({active:a.length,ahead:mine<0?null:mine})});
app.post('/api/admin/v26/dm/:uid',needAdmin,async(q,res)=>{try{await dm(q.params.uid,String(q.body.message||'').trim());res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/v26/staff',needAdmin,(q,res)=>res.json(v25().staff));
app.put('/api/admin/v26/staff',needAdmin,(q,res)=>{const x=v25();x.staff=Array.isArray(q.body.staff)?q.body.staff:[];save25(x);act('staff','Zmieniono listę pracowników',q.session.user.username);res.json({ok:true,staff:x.staff})});
app.get('/api/staff/orders',needStaff,(q,res)=>{const x=v25(),uid=q.session.user.id;res.json(read(ORD,[]).filter(o=>admin(q)||String(x.assignments[o.id]||'')===String(uid)))});
app.post('/api/admin/v26/backup',needAdmin,(q,res)=>{const stamp=new Date().toISOString().replace(/[:.]/g,'-'),name=`backup-${stamp}.json`;const payload={version:26,createdAt:new Date().toISOString(),orders:read(ORD,[]),content:read(CONTENT,defaults),stats:read(STATS,{}),v25:v25()};fs.writeFileSync(path.join(BACKUPS,name),JSON.stringify(payload,null,2));res.json({ok:true,name})});
app.get('/api/admin/v26/backups',needAdmin,(q,res)=>res.json(fs.readdirSync(BACKUPS).filter(x=>x.endsWith('.json')).sort().reverse()));
app.post('/api/admin/v26/restore/:name',needAdmin,(q,res)=>{const name=path.basename(q.params.name),f=path.join(BACKUPS,name);if(!fs.existsSync(f))return res.status(404).json({error:'Backup nie istnieje.'});const b=read(f,null);if(!b)return res.status(400).json({error:'Uszkodzony backup.'});write(ORD,b.orders||[]);write(CONTENT,b.content||defaults);write(STATS,b.stats||{});save25(b.v25||v25Default);res.json({ok:true})});
app.delete('/api/admin/v26/backup/:name',needAdmin,(q,res)=>{const f=path.join(BACKUPS,path.basename(q.params.name));if(fs.existsSync(f))fs.unlinkSync(f);res.json({ok:true})});
app.post('/api/admin/v26/order/:id/notify',needAdmin,async(q,res)=>{const a=read(ORD,[]),o=a.find(x=>x.id===q.params.id);if(!o)return res.status(404).json({error:'Brak zamówienia.'});const text=String(q.body.message||'Aktualizacja Twojego zamówienia.');notify(o.userId,text,'order');let dmSent=false;try{await dm(o.userId,`**VANTA HUB • ZAMÓWIENIE ${o.shortId||o.id}**\n${text}`);dmSent=true}catch{}res.json({ok:true,dmSent})});
app.get('/p/:id',(q,res)=>res.sendFile(path.join(ROOT,'index.html')));
app.get('/order/:id',(q,res)=>res.sendFile(path.join(ROOT,'index.html')));


// ===== VANTA BOT COMMANDS V32 =====
const dclient=new Client({intents:[GatewayIntentBits.Guilds]});
const cmdDefs=[
 new SlashCommandBuilder().setName("claim").setDescription("Przejmij to zamówienie"),
 new SlashCommandBuilder().setName("unclaim").setDescription("Oddaj to zamówienie"),
 new SlashCommandBuilder().setName("close").setDescription("Zamknij to zamówienie"),
 new SlashCommandBuilder().setName("reopen").setDescription("Otwórz ponownie zamówienie"),
 new SlashCommandBuilder().setName("status").setDescription("Zmień status zamówienia").addStringOption(o=>o.setName("status").setDescription("Nowy status").setRequired(true).addChoices(
  {name:"Oczekuje",value:"pending"},{name:"W realizacji",value:"in_progress"},{name:"Gotowe",value:"done"},{name:"Zamknięte",value:"closed"})),
 new SlashCommandBuilder().setName("price").setDescription("Ustaw cenę końcową").addNumberOption(o=>o.setName("pln").setDescription("Cena w PLN").setRequired(true).setMinValue(0)),
 new SlashCommandBuilder().setName("deadline").setDescription("Ustaw termin realizacji").addStringOption(o=>o.setName("data").setDescription("Np. 20.09.2026").setRequired(true)),
 new SlashCommandBuilder().setName("rename").setDescription("Zmień nazwę kanału zamówienia").addStringOption(o=>o.setName("nazwa").setDescription("Nowa nazwa").setRequired(true)),
 new SlashCommandBuilder().setName("add").setDescription("Dodaj osobę do zamówienia").addUserOption(o=>o.setName("osoba").setDescription("Osoba").setRequired(true)),
 new SlashCommandBuilder().setName("remove").setDescription("Usuń osobę z zamówienia").addUserOption(o=>o.setName("osoba").setDescription("Osoba").setRequired(true)),
 new SlashCommandBuilder().setName("info").setDescription("Pokaż informacje o zamówieniu"),
 new SlashCommandBuilder().setName("dm").setDescription("Wyślij klientowi wiadomość prywatną").addStringOption(o=>o.setName("wiadomosc").setDescription("Treść DM").setRequired(true)),
 new SlashCommandBuilder().setName("komendy").setDescription("Pokaż wszystkie komendy VANTA BOT"),
 new SlashCommandBuilder().setName("website").setDescription("Wyślij embed VANTA HUB z linkiem do strony"),
 new SlashCommandBuilder().setName("say").setDescription("Wyślij wiadomość jako VANTA BOT").addStringOption(o=>o.setName("wiadomosc").setDescription("Treść wiadomości").setRequired(true)),
 new SlashCommandBuilder().setName("embed").setDescription("Wyślij własny embed jako VANTA BOT").addStringOption(o=>o.setName("tytul").setDescription("Tytuł").setRequired(true)).addStringOption(o=>o.setName("wiadomosc").setDescription("Treść").setRequired(true)).addStringOption(o=>o.setName("link").setDescription("Opcjonalny link")),
 new SlashCommandBuilder().setName("partner").setDescription("Wyślij profesjonalny post partnerski jako bot").addStringOption(o=>o.setName("nazwa").setDescription("Nazwa partnera").setRequired(true)).addStringOption(o=>o.setName("wiadomosc").setDescription("Opis partnerstwa").setRequired(true)).addStringOption(o=>o.setName("link").setDescription("Link").setRequired(true)),
 new SlashCommandBuilder().setName("announce").setDescription("Wyślij ogłoszenie VANTA").addStringOption(o=>o.setName("tytul").setDescription("Tytuł").setRequired(true)).addStringOption(o=>o.setName("wiadomosc").setDescription("Treść").setRequired(true)),
 new SlashCommandBuilder().setName("mute").setDescription("Wycisz użytkownika").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addIntegerOption(o=>o.setName("minuty").setDescription("Czas w minutach").setRequired(true).setMinValue(1).setMaxValue(40320)).addStringOption(o=>o.setName("powod").setDescription("Powód")),
 new SlashCommandBuilder().setName("unmute").setDescription("Zdejmij wyciszenie").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)),
 new SlashCommandBuilder().setName("kick").setDescription("Wyrzuć użytkownika").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addStringOption(o=>o.setName("powod").setDescription("Powód")),
 new SlashCommandBuilder().setName("ban").setDescription("Zbanuj użytkownika").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addStringOption(o=>o.setName("powod").setDescription("Powód")),
 new SlashCommandBuilder().setName("unban").setDescription("Odbanuj użytkownika po ID").addStringOption(o=>o.setName("id").setDescription("Discord User ID").setRequired(true)),
 new SlashCommandBuilder().setName("clear").setDescription("Usuń ostatnie wiadomości").addIntegerOption(o=>o.setName("ilosc").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
 new SlashCommandBuilder().setName("slowmode").setDescription("Ustaw slowmode kanału").addIntegerOption(o=>o.setName("sekundy").setDescription("0 wyłącza; max 21600").setRequired(true).setMinValue(0).setMaxValue(21600)),
 new SlashCommandBuilder().setName("lock").setDescription("Zablokuj pisanie na kanale"),
 new SlashCommandBuilder().setName("unlock").setDescription("Odblokuj pisanie na kanale"),
 new SlashCommandBuilder().setName("nick").setDescription("Zmień nick użytkownika").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addStringOption(o=>o.setName("nick").setDescription("Nowy nick; wpisz - aby usunąć").setRequired(true)),
 new SlashCommandBuilder().setName("roleadd").setDescription("Dodaj rolę użytkownikowi").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addRoleOption(o=>o.setName("rola").setDescription("Rola").setRequired(true)),
 new SlashCommandBuilder().setName("roleremove").setDescription("Usuń rolę użytkownikowi").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik").setRequired(true)).addRoleOption(o=>o.setName("rola").setDescription("Rola").setRequired(true)),
 new SlashCommandBuilder().setName("serverinfo").setDescription("Pokaż informacje o serwerze"),
 new SlashCommandBuilder().setName("userinfo").setDescription("Pokaż informacje o użytkowniku").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik")),
 new SlashCommandBuilder().setName("avatar").setDescription("Pokaż avatar użytkownika").addUserOption(o=>o.setName("osoba").setDescription("Użytkownik")),
 new SlashCommandBuilder().setName("ping").setDescription("Sprawdź VANTA BOT"),
 new SlashCommandBuilder().setName("delete").setDescription("Usuń kanał zamówienia")
].map(x=>x.toJSON());

function orderByChannel(cid){const a=read(ORD,[]);return {a,o:a.find(x=>String(x.ticketChannelId)===String(cid))}}
function staffInteraction(i){
 if(ADMINS.includes(String(i.user.id)))return true;
 try{return i.memberPermissions?.has(PermissionFlagsBits.ManageChannels)||i.memberPermissions?.has(PermissionFlagsBits.Administrator)}catch{return false}
}
const statusNames={pending:"🟡 Oczekuje",in_progress:"🔵 W realizacji",done:"🟢 Gotowe",closed:"⚫ Zamknięte"};
async function syncOrderMessage(o){
 if(!o.ticketChannelId||!o.ticketMessageId)return;
 try{
  const cur=await discord(`/channels/${o.ticketChannelId}/messages/${o.ticketMessageId}`);
  const em={...(cur.embeds?.[0]||{})}; delete em.type; delete em.provider; delete em.video;
  em.fields=(em.fields||[]).filter(f=>f.name!=="Status"&&f.name!=="Realizuje"&&f.name!=="Cena końcowa"&&f.name!=="Termin");
  em.fields.push({name:"Status",value:statusNames[o.status]||o.status,inline:true});
  const x=v25();
  if(x.assignments[o.id])em.fields.push({name:"Realizuje",value:`<@${x.assignments[o.id]}>`,inline:true});
  if(x.finalPrice[o.id]!==undefined&&x.finalPrice[o.id]!=="")em.fields.push({name:"Cena końcowa",value:`${x.finalPrice[o.id]} PLN`,inline:true});
  if(x.deadlines[o.id])em.fields.push({name:"Termin",value:String(x.deadlines[o.id]),inline:true});
  await discord(`/channels/${o.ticketChannelId}/messages/${o.ticketMessageId}`,{method:"PATCH",body:JSON.stringify({embeds:[em]})});
 }catch(e){console.error("[VANTA BOT sync]",e.message)}
}
async function setOrderStatus(o,a,status){
 o.status=status;o.updatedAt=new Date().toISOString();write(ORD,a);await syncOrderMessage(o);
}
async function claimOrder(i,o){
 const x=v25();x.assignments[o.id]=String(i.user.id);x.history[o.id]=x.history[o.id]||[];
 x.history[o.id].push({at:new Date().toISOString(),by:i.user.id,change:{claim:i.user.id}});save25(x);
 await syncOrderMessage(o);
}
function cleanChannelName(v){return String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9_-]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,90)||"zamowienie"}
async function closeOrder(i,o,a){
 await setOrderStatus(o,a,"closed");
 try{await i.channel.permissionOverwrites.edit(o.userId,{SendMessages:false})}catch{}
 try{await i.channel.setName(`zamkniete-${String(o.shortId||o.id).toLowerCase()}`)}catch{}
}
async function reopenOrder(i,o,a){
 await setOrderStatus(o,a,"in_progress");
 try{await i.channel.permissionOverwrites.edit(o.userId,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,AttachFiles:true,EmbedLinks:true})}catch{}
 try{await i.channel.setName(`zamowienie-${String(o.shortId||o.id).toLowerCase()}`)}catch{}
}
async function replySafe(i,payload){if(i.replied||i.deferred)return i.followUp(payload);return i.reply(payload)}

async function registerVantaCommands(){
 if(!BOT||!CLIENT||!GUILD)return console.log("[VANTA BOT] Pomijam komendy: brak konfiguracji.");
 try{
  const rest=new REST({version:"10"}).setToken(BOT);
  await rest.put(Routes.applicationGuildCommands(CLIENT,GUILD),{body:cmdDefs});
  console.log(`[VANTA BOT] Zarejestrowano ${cmdDefs.length} komend slash.`);
 }catch(e){console.error("[VANTA BOT commands]",e.message)}
}
dclient.once("clientReady",()=>console.log(`[VANTA BOT] Online jako ${dclient.user.tag}`));
dclient.on("interactionCreate",async i=>{
 try{
  if(!i.inGuild())return;
  if(i.isButton()){
   if(!["vanta_claim","vanta_progress","vanta_done","vanta_close","vanta_delete_yes","vanta_delete_no"].includes(i.customId))return;
   if(!staffInteraction(i))return replySafe(i,{content:"Nie masz uprawnień pracownika do tej akcji.",ephemeral:true});
   const {a,o}=orderByChannel(i.channelId);if(!o)return replySafe(i,{content:"Ten kanał nie jest powiązany z zamówieniem VANTA.",ephemeral:true});
   if(i.customId==="vanta_claim"){await claimOrder(i,o);return replySafe(i,{content:`✅ Zamówienie przejął <@${i.user.id}>.`})}
   if(i.customId==="vanta_progress"){await setOrderStatus(o,a,"in_progress");return replySafe(i,{content:"🔵 Status: **W realizacji**."})}
   if(i.customId==="vanta_done"){await setOrderStatus(o,a,"done");return replySafe(i,{content:"🟢 Status: **Gotowe**."})}
   if(i.customId==="vanta_close"){await closeOrder(i,o,a);return replySafe(i,{content:"⚫ Zamówienie zostało zamknięte."})}
   if(i.customId==="vanta_delete_no")return i.update({content:"Anulowano usuwanie.",components:[]});
   if(i.customId==="vanta_delete_yes"){await i.update({content:"Usuwam kanał…",components:[]});setTimeout(()=>i.channel.delete("VANTA /delete").catch(()=>{}),700);return}
  }
  if(!i.isChatInputCommand())return;
  if(!staffInteraction(i))return replySafe(i,{content:"Nie masz uprawnień pracownika do używania tych komend.",ephemeral:true});
  const c=i.commandName;
  const globalCommands=new Set(["komendy","website","say","embed","partner","announce","mute","unmute","kick","ban","unban","clear","slowmode","lock","unlock","nick","roleadd","roleremove","serverinfo","userinfo","avatar","ping"]);
  if(globalCommands.has(c)){
   const reason=()=>i.options.getString("powod")||`VANTA BOT • ${i.user.tag}`;
   if(c==="komendy"){
    return replySafe(i,{embeds:[{
     title:"VANTA BOT • KOMENDY",
     description:"Pełna lista komend VANTA BOT. Nazwy poniżej są pełnymi nazwami komend slash.",
     color:0x111116,
     fields:[
      {name:"🛒 ZAMÓWIENIA",value:"`/claim` — przejmij zamówienie\n`/unclaim` — oddaj zamówienie\n`/close` — zamknij zamówienie\n`/reopen` — otwórz ponownie\n`/status` — zmień status\n`/price` — ustaw cenę\n`/deadline` — ustaw termin\n`/rename` — zmień nazwę kanału\n`/add` — dodaj osobę\n`/remove` — usuń osobę\n`/info` — informacje o zamówieniu\n`/dm` — DM do klienta\n`/delete` — usuń kanał"},
      {name:"📢 VANTA BOT",value:"`/website` — embed strony VANTA HUB\n`/say` — wiadomość jako bot\n`/embed` — własny embed\n`/partner` — post partnerski\n`/announce` — ogłoszenie"},
      {name:"🛡️ MODERACJA",value:"`/mute` — wycisz użytkownika\n`/unmute` — zdejmij wyciszenie\n`/kick` — wyrzuć użytkownika\n`/ban` — zbanuj użytkownika\n`/unban` — odbanuj po ID\n`/clear` — usuń wiadomości\n`/slowmode` — ustaw slowmode\n`/lock` — zablokuj kanał\n`/unlock` — odblokuj kanał\n`/nick` — zmień nick\n`/roleadd` — dodaj rolę\n`/roleremove` — usuń rolę"},
      {name:"⚙️ NARZĘDZIA",value:"`/serverinfo` — informacje o serwerze\n`/userinfo` — informacje o użytkowniku\n`/avatar` — pokaż avatar\n`/ping` — sprawdź bota\n`/komendy` — pokaż tę listę"}
     ],
     footer:{text:"VANTA HUB • BOT COMMAND CENTER"}
    }],ephemeral:true});
   }
   if(c==="website"){
    const url=process.env.WEBSITE_URL||process.env.SITE_URL||"http://localhost:3000";
    return replySafe(i,{embeds:[{title:"VANTA HUB • PREMIUM FIVEM ASSETS",description:"**Skiny • Mody • Citizeny • Custom Skin • Custom Koszulka**\n\nKatalog połączony z Discordem, prywatne zamówienia, tracking realizacji, portfolio, opinie, changelog i VANTA Custom Studio.",url,color:0x111116,fields:[{name:"STRONA",value:`[OTWÓRZ VANTA HUB](${url})`,inline:true},{name:"STATUS",value:"🟢 ONLINE",inline:true}],footer:{text:"VANTA HUB • EXCLUSIVE FIVEM SHOP"}}]});
   }
   if(c==="say"){await i.deferReply({ephemeral:true});await i.channel.send({content:i.options.getString("wiadomosc",true),allowedMentions:{parse:["users","roles","everyone"]}});return i.editReply("✅ Wysłano jako VANTA BOT.")}
   if(c==="embed"){const title=i.options.getString("tytul",true),description=i.options.getString("wiadomosc",true),url=i.options.getString("link")||undefined;await i.deferReply({ephemeral:true});await i.channel.send({embeds:[{title,description,url,color:0x111116,footer:{text:"VANTA HUB"}}]});return i.editReply("✅ Embed wysłany jako VANTA BOT.")}
   if(c==="partner"){const name=i.options.getString("nazwa",true),description=i.options.getString("wiadomosc",true),url=i.options.getString("link",true);await i.deferReply({ephemeral:true});await i.channel.send({embeds:[{author:{name:"VANTA HUB • PARTNERSHIP"},title:name,description,url,color:0x111116,fields:[{name:"PARTNER",value:`[PRZEJDŹ](${url})`}],footer:{text:"VANTA HUB • OFFICIAL PARTNERSHIP"}}]});return i.editReply("✅ Post partnerski wysłany przez bota.")}
   if(c==="announce"){
    const title=i.options.getString("tytul",true).trim();
    const message=i.options.getString("wiadomosc",true).trim();
    const content=`# ${title}\n\n**${message}**`;
    await i.channel.send({
     content,
     allowedMentions:{parse:["users","roles","everyone"]}
    });
    return replySafe(i,{content:"Ogłoszenie wysłane.",ephemeral:true});
   }

   if(c==="mute"){const u=i.options.getUser("osoba",true),mins=i.options.getInteger("minuty",true),until=new Date(Date.now()+mins*60000).toISOString();await discord(`/guilds/${i.guildId}/members/${u.id}`,{method:"PATCH",body:JSON.stringify({communication_disabled_until:until})});return replySafe(i,{content:`🔇 <@${u.id}> wyciszony na **${mins} min**. Powód: ${reason()}`})}
   if(c==="unmute"){const u=i.options.getUser("osoba",true);await discord(`/guilds/${i.guildId}/members/${u.id}`,{method:"PATCH",body:JSON.stringify({communication_disabled_until:null})});return replySafe(i,{content:`🔊 Zdjęto wyciszenie z <@${u.id}>.`})}
   if(c==="kick"){const u=i.options.getUser("osoba",true);if(u.id===i.user.id)return replySafe(i,{content:"Nie możesz wyrzucić siebie.",ephemeral:true});await discord(`/guilds/${i.guildId}/members/${u.id}`,{method:"DELETE",headers:{"X-Audit-Log-Reason":encodeURIComponent(reason())}});return replySafe(i,{content:`👢 Wyrzucono **${u.tag}**.`})}
   if(c==="ban"){const u=i.options.getUser("osoba",true);if(u.id===i.user.id)return replySafe(i,{content:"Nie możesz zbanować siebie.",ephemeral:true});await discord(`/guilds/${i.guildId}/bans/${u.id}`,{method:"PUT",headers:{"X-Audit-Log-Reason":encodeURIComponent(reason())},body:JSON.stringify({delete_message_seconds:0})});return replySafe(i,{content:`🔨 Zbanowano **${u.tag}**.`})}
   if(c==="unban"){const uid=i.options.getString("id",true).replace(/\D/g,"");if(!uid)return replySafe(i,{content:"Nieprawidłowe ID.",ephemeral:true});await discord(`/guilds/${i.guildId}/bans/${uid}`,{method:"DELETE"});return replySafe(i,{content:`✅ Odbanowano użytkownika \`${uid}\`.`})}
   if(c==="clear"){const n=i.options.getInteger("ilosc",true);if(!i.channel.bulkDelete)return replySafe(i,{content:"Ten kanał nie obsługuje czyszczenia.",ephemeral:true});await i.deferReply({ephemeral:true});const deleted=await i.channel.bulkDelete(n,true);return i.editReply(`🧹 Usunięto **${deleted.size}** wiadomości.`)}
   if(c==="slowmode"){const sec=i.options.getInteger("sekundy",true);await i.channel.setRateLimitPerUser(sec,`VANTA /slowmode by ${i.user.tag}`);return replySafe(i,{content:sec?`⏱️ Slowmode: **${sec}s**.`:"⏱️ Slowmode wyłączony."})}
   if(c==="lock"||c==="unlock"){await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:c==="unlock"?null:false});return replySafe(i,{content:c==="lock"?"🔒 Kanał zablokowany.":"🔓 Kanał odblokowany."})}
   if(c==="nick"){const u=i.options.getUser("osoba",true),nick=i.options.getString("nick",true);await discord(`/guilds/${i.guildId}/members/${u.id}`,{method:"PATCH",body:JSON.stringify({nick:nick==="-"?null:nick.slice(0,32)})});return replySafe(i,{content:`✏️ Zmieniono nick **${u.tag}**.`})}
   if(c==="roleadd"||c==="roleremove"){const u=i.options.getUser("osoba",true),role=i.options.getRole("rola",true);await discord(`/guilds/${i.guildId}/members/${u.id}/roles/${role.id}`,{method:c==="roleadd"?"PUT":"DELETE"});return replySafe(i,{content:`${c==="roleadd"?"➕ Dodano":"➖ Usunięto"} rolę **${role.name}** ${c==="roleadd"?"u":"od"} <@${u.id}>.`})}
   if(c==="serverinfo"){return replySafe(i,{embeds:[{title:`${i.guild.name} • SERVER INFO`,color:0x111116,fields:[{name:"Użytkownicy",value:String(i.guild.memberCount),inline:true},{name:"Kanały",value:String(i.guild.channels.cache.size),inline:true},{name:"Role",value:String(i.guild.roles.cache.size),inline:true},{name:"ID",value:i.guild.id,inline:true},{name:"Utworzony",value:`<t:${Math.floor(i.guild.createdTimestamp/1000)}:D>`,inline:true}]}]})}
   if(c==="userinfo"){const u=i.options.getUser("osoba")||i.user;return replySafe(i,{embeds:[{title:`${u.tag} • USER INFO`,thumbnail:{url:u.displayAvatarURL({size:256})},color:0x111116,fields:[{name:"ID",value:u.id,inline:true},{name:"Konto utworzone",value:`<t:${Math.floor(u.createdTimestamp/1000)}:D>`,inline:true},{name:"Bot",value:u.bot?"Tak":"Nie",inline:true}]}]})}
   if(c==="avatar"){const u=i.options.getUser("osoba")||i.user;return replySafe(i,{embeds:[{title:`Avatar • ${u.tag}`,image:{url:u.displayAvatarURL({size:1024})},color:0x111116}]})}
   if(c==="ping"){return replySafe(i,{content:`🏓 VANTA BOT • **${Math.max(0,Date.now()-i.createdTimestamp)}ms**`,ephemeral:true})}
  }
  const {a,o}=orderByChannel(i.channelId);
  if(!o)return replySafe(i,{content:"Ta komenda działa tylko na kanale zamówienia VANTA.",ephemeral:true});
  if(c==="claim"){await claimOrder(i,o);return replySafe(i,{content:`✅ Zamówienie przejął <@${i.user.id}>.`})}
  if(c==="unclaim"){const x=v25();delete x.assignments[o.id];save25(x);await syncOrderMessage(o);return replySafe(i,{content:"↩️ Zamówienie zostało oddane."})}
  if(c==="close"){await closeOrder(i,o,a);return replySafe(i,{content:"⚫ Zamówienie zostało zamknięte."})}
  if(c==="reopen"){await reopenOrder(i,o,a);return replySafe(i,{content:"🔵 Zamówienie zostało ponownie otwarte."})}
  if(c==="status"){const st=i.options.getString("status",true);await setOrderStatus(o,a,st);return replySafe(i,{content:`Status zmieniony: **${statusNames[st]}**.`})}
  if(c==="price"){const n=i.options.getNumber("pln",true),x=v25();x.finalPrice[o.id]=n;save25(x);await syncOrderMessage(o);return replySafe(i,{content:`💰 Cena końcowa: **${n} PLN**.`})}
  if(c==="deadline"){const d=i.options.getString("data",true),x=v25();x.deadlines[o.id]=d;save25(x);await syncOrderMessage(o);return replySafe(i,{content:`📅 Termin realizacji: **${d}**.`})}
  if(c==="rename"){const n=cleanChannelName(i.options.getString("nazwa",true));await i.channel.setName(n);return replySafe(i,{content:`✏️ Nazwa kanału zmieniona na **#${n}**.`})}
  if(c==="add"){const u=i.options.getUser("osoba",true);await i.channel.permissionOverwrites.edit(u.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,AttachFiles:true,EmbedLinks:true});return replySafe(i,{content:`➕ Dodano <@${u.id}> do zamówienia.`})}
  if(c==="remove"){const u=i.options.getUser("osoba",true);if(String(u.id)===String(o.userId))return replySafe(i,{content:"Klienta zamówienia nie usuwaj tą komendą. Użyj /close.",ephemeral:true});await i.channel.permissionOverwrites.delete(u.id).catch(()=>{});return replySafe(i,{content:`➖ Usunięto <@${u.id}> z zamówienia.`})}
  if(c==="info"){const x=v25();return replySafe(i,{embeds:[{title:`VANTA HUB • ${o.shortId||o.id}`,fields:[
   {name:"Klient",value:`<@${o.userId}>`,inline:true},{name:"Produkt",value:String(o.product),inline:true},{name:"Status",value:statusNames[o.status]||o.status,inline:true},
   {name:"Realizuje",value:x.assignments[o.id]?`<@${x.assignments[o.id]}>`:"Nikt",inline:true},{name:"Cena",value:x.finalPrice[o.id]!==undefined&&x.finalPrice[o.id]!==""?`${x.finalPrice[o.id]} PLN`:`${o.price} PLN bazowo`,inline:true},{name:"Termin",value:String(x.deadlines[o.id]||"Nie ustawiono"),inline:true}
  ]}]})}
  if(c==="dm"){const text=i.options.getString("wiadomosc",true);await dm(o.userId,`**VANTA HUB • ZAMÓWIENIE ${o.shortId||o.id}**\n${text}`);return replySafe(i,{content:"📨 Wiadomość DM została wysłana.",ephemeral:true})}
  if(c==="delete"){const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("vanta_delete_yes").setLabel("USUŃ KANAŁ").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("vanta_delete_no").setLabel("ANULUJ").setStyle(ButtonStyle.Secondary));return replySafe(i,{content:"⚠️ Na pewno usunąć ten kanał? Tej operacji nie można cofnąć.",components:[row],ephemeral:true})}
 }catch(e){
  console.error("[VANTA BOT interaction]",e);
  try{await replySafe(i,{content:"Wystąpił błąd: "+String(e.message||e).slice(0,500),ephemeral:true})}catch{}
 }
});
if(BOT){
 registerVantaCommands();
 dclient.login(BOT).catch(e=>console.error("[VANTA BOT login]",e.message));
}


// V41 - same-origin Discord avatar proxy
app.get("/api/discord/avatar",async(q,res)=>{
 try{
  if(!q.session?.user?.id)return res.status(401).end();
  const u=q.session.user;
  let url="";
  if(u.avatar){
   const ext=String(u.avatar).startsWith("a_")?"gif":"png";
   url=`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
  }else{
   let idx=0; try{idx=Number((BigInt(u.id)>>22n)%6n)}catch{}
   url=`https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  const rr=await fetch(url);
  if(!rr.ok)throw Error("avatar");
  res.set("Content-Type",rr.headers.get("content-type")||"image/png");
  res.set("Cache-Control","private, max-age=300");
  res.send(Buffer.from(await rr.arrayBuffer()));
 }catch(e){res.status(404).end()}
});

initPersistentStore().finally(()=>app.listen(PORT,()=>console.log("VANTA HUB ONLINE • PORT "+PORT)));
