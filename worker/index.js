// SDP MERCH secure checkout API for Cloudflare Workers + D1.
// NEVER place Stripe keys in the GitHub Pages frontend.
const CATALOG = Object.freeze({
  L: { name:'Lanyard SDP', cents:500 },
  P: { name:'Parche bordado', cents:500 },
  Q: { name:'Pack de 3 pegatinas', cents:100 },
  Y: { name:'Llavero bordado', cents:500 },
})
const SITE_URL = 'https://spidey000.github.io/sdp_merch/'
const STOCK_SKU = 'Q'
const PACK_UNITS = 3
const HOLD_SECONDS = 35*60 // Must exceed 30-minute minimum at Stripe API receipt.

function http(status,data,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store',...headers}})
}
function withCors(response,origin){
  if(origin===new URL(SITE_URL).origin){
    response.headers.set('access-control-allow-origin',origin)
    response.headers.set('access-control-allow-methods','GET, POST, OPTIONS')
    response.headers.set('access-control-allow-headers','Content-Type')
  }
  response.headers.set('vary','Origin')
  return response
}
function fail(message,status=400){const e=new Error(message);e.httpStatus=status;return e}
function configured(env){return !!(env.DB && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)}
function parseCart(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Carrito inválido')
  const cart={}
  for(const [id, qty] of Object.entries(input)){
    if(!Object.hasOwn(CATALOG,id)||!Number.isSafeInteger(qty)||qty<0||qty>99)throw fail('Producto o cantidad inválidos')
    if(qty>0)cart[id]=qty
  }
  if(Object.keys(cart).length===0)throw fail('Carrito vacío')
  return cart
}
function orderDetails(cart){
  const ids=Object.keys(CATALOG).filter(id=>cart[id]>0)
  return {cents:ids.reduce((sum,id)=>sum+CATALOG[id].cents*cart[id],0),
    stickerCount:(cart.Q||0)*PACK_UNITS,
    concept:['SDP MERCH',...ids.map(id=>`${id}${cart[id]}`)].join(' '),
    items:ids.map(id=>({id,quantity:cart[id],...CATALOG[id]}))}
}
async function stripe(env,path,{method='GET',form,idempotencyKey}={}){
  const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`}
  if(form)headers['Content-Type']='application/x-www-form-urlencoded'
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey
  const response=await fetch('https://api.stripe.com/v1'+path,{
    method,headers,body:form?.toString(),signal:AbortSignal.timeout(12000)
  })
  const data=await response.json()
  if(!response.ok)throw fail(data?.error?.message||'Error de Stripe',response.status>=500?503:400)
  return data
}
function checkoutFields(details,id){
  const form=new URLSearchParams()
  form.set('mode','payment')
  form.set('payment_method_types[0]','card')
  form.set('payment_method_types[1]','bizum')
  form.set('locale','es')
  form.set('success_url',SITE_URL+'?payment=success&session_id={CHECKOUT_SESSION_ID}')
  form.set('cancel_url',SITE_URL+'?payment=cancel')
  form.set('expires_at',String(Math.floor(Date.now()/1000)+HOLD_SECONDS))
  form.set('client_reference_id',id)
  form.set('metadata[reservation_id]',id)
  form.set('metadata[concept]',details.concept)
  form.set('payment_intent_data[description]',details.concept)
  form.set('payment_intent_data[metadata][concept]',details.concept)
  form.set('phone_number_collection[enabled]','true')
  details.items.forEach((item,i)=>{
    const p=`line_items[${i}]`
    form.set(p+'[quantity]',String(item.quantity))
    form.set(p+'[price_data][currency]','eur')
    form.set(p+'[price_data][unit_amount]',String(item.cents))
    form.set(p+'[price_data][product_data][name]',item.name)
  })
  return form
}
async function available(db){
  const row=await db.prepare('SELECT available FROM inventory WHERE sku=?').bind(STOCK_SKU).first()
  if(!row || !Number.isSafeInteger(row.available) || row.available<0)throw new Error('Inventario no inicializado correctamente')
  return row.available
}
async function reserve(db,id,stickerCount){
  const now=Date.now()
  // D1 batch is transactional: the conditional insert and decrement happen together.
  // Concurrent checkouts cannot reserve the same last stickers.
  const results=await db.batch([
    db.prepare(`INSERT INTO reservations(id,qty,status,created_at,expires_at)
      SELECT ?,?,'reserved',?,? WHERE (SELECT available FROM inventory WHERE sku=?)>=?`)
      .bind(id,stickerCount,now,now+45*60*1000,STOCK_SKU,stickerCount),
    db.prepare(`UPDATE inventory SET available=available-? WHERE sku=? AND EXISTS
      (SELECT 1 FROM reservations WHERE id=? AND status='reserved')`).bind(stickerCount,STOCK_SKU,id),
  ])
  if(results[0].meta.changes!==1) throw fail('No quedan suficientes pegatinas disponibles',409)
}
async function attachSession(db,id,session){
  await db.prepare('UPDATE reservations SET session_id=?,expires_at=? WHERE id=?')
    .bind(session.id,session.expires_at*1000+60000,id).run()
}
async function transition(db,id,target){
  if(target==='paid'){
    await db.prepare("UPDATE reservations SET status='paid' WHERE id=? AND status='reserved'").bind(id).run()
    return
  }
  if(target!=='released')throw new Error('Transición inválida')
  await db.batch([
    db.prepare(`UPDATE inventory SET available=available+COALESCE(
      (SELECT qty FROM reservations WHERE id=? AND status='reserved'),0) WHERE sku=?`).bind(id,STOCK_SKU),
    db.prepare("UPDATE reservations SET status='released' WHERE id=? AND status='reserved'").bind(id),
  ])
}
async function reconcile(env){
  const now=Date.now()
  const records=await env.DB.prepare(`SELECT id,session_id,created_at FROM reservations
    WHERE status='reserved' AND expires_at < ? LIMIT 8`).bind(now).all()
  for(const rec of records.results||[]){
    try{
      if(!rec.session_id){
        if(now-rec.created_at>45*60*1000)await transition(env.DB,rec.id,'released')
        continue
      }
      let session=await stripe(env,`/checkout/sessions/${encodeURIComponent(rec.session_id)}`)
      if(session.status==='open' && session.expires_at*1000<=now){
        session=await stripe(env,`/checkout/sessions/${encodeURIComponent(rec.session_id)}/expire`,{method:'POST'})
      }
      if(session.payment_status==='paid')await transition(env.DB,rec.id,'paid')
      else if(session.status==='expired')await transition(env.DB,rec.id,'released')
    }catch(e){console.error('Stock reconciliation postponed:',e.message)}
  }
}
async function verifyWebhook(request,secret){
  const raw=await request.text()
  if(raw.length>500000)throw fail('Evento demasiado grande',413)
  const signature=request.headers.get('stripe-signature')||''
  const t=signature.match(/(?:^|,)t=(\d+)/)?.[1]
  const versions=[...signature.matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map(m=>m[1])
  if(!t || !versions.length || Math.abs(Date.now()/1000-Number(t))>300)throw fail('Firma ausente o caducada',400)
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const result=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${t}.${raw}`))
  const expected=Array.from(new Uint8Array(result),v=>v.toString(16).padStart(2,'0')).join('')
  let valid=false
  for(const v of versions){let difference=0;for(let i=0;i<64;i++)difference|=(v.charCodeAt(i)^expected.charCodeAt(i));valid||=difference===0}
  if(!valid)throw fail('Firma no válida',400)
  try{return JSON.parse(raw)}catch{throw fail('JSON inválido',400)}
}
async function handleWebhook(request,env){
  if(request.method!=='POST')return http(405,{error:'Método no permitido'})
  const evt=await verifyWebhook(request,env.STRIPE_WEBHOOK_SECRET)
  const session=evt.data?.object
  const id=session?.metadata?.reservation_id
  if(typeof id!=='string' || !/^[0-9a-f-]{36}$/.test(id))return http(200,{received:true})
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(evt.type)){
    if(session.payment_status==='paid')await transition(env.DB,id,'paid')
  }else if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(evt.type)){
    await transition(env.DB,id,'released')
  }
  return http(200,{received:true})
}

export default {
  async fetch(request,env){
    const url=new URL(request.url)
    if(url.pathname==='/api/stripe-webhook'){
      try{return await handleWebhook(request,env)}catch(e){
        console.error('[SDP webhook]',e.message)
        return http(e.httpStatus===400?400:500,{error:e.httpStatus===400?'Firma inválida':'Error temporal'})
      }
    }
    const origin=request.headers.get('origin')
    if(origin && origin!==new URL(SITE_URL).origin)return http(403,{error:'Origen no autorizado'})
    if(request.method==='OPTIONS')return withCors(new Response(null,{status:204}),origin)
    try{
      if(url.pathname==='/api/stock'&&request.method==='GET'){
        if(!env.DB)return withCors(http(200,{ready:false,remaining:null,packs:null,initial:1000}),origin)
        if(configured(env))await reconcile(env)
        const remaining=await available(env.DB)
        return withCors(http(200,{ready:configured(env),remaining,packs:Math.floor(remaining/PACK_UNITS),initial:1000}),origin)
      }
      if(url.pathname==='/api/checkout'&&request.method==='POST'){
        if(!configured(env))return withCors(http(503,{error:'El pago seguro aún no está activado'}),origin)
        const body = await request.json()
        const cart = parseCart(body?.cart)
        const details=orderDetails(cart)
        await reconcile(env)
        const id=crypto.randomUUID()
        await reserve(env.DB,id,details.stickerCount)
        let sessionCreated=false
        try{
          const session=await stripe(env,'/checkout/sessions',{method:'POST',form:checkoutFields(details,id),idempotencyKey:id})
          sessionCreated=true
          await attachSession(env.DB,id,session)
          if(!session.url?.startsWith('https://checkout.stripe.com/'))throw new Error('URL de Stripe inesperada')
          return withCors(http(200,{url:session.url,concept:details.concept}),origin)
        }catch(e){
          // Avoid releasing a reservation after a possibly successful but timed-out Stripe call.
          if(!sessionCreated && e.httpStatus===400)await transition(env.DB,id,'released')
          throw e
        }
      }
      if(url.pathname==='/api/order'&&request.method==='GET'){
        if(!configured(env))return withCors(http(503,{error:'No configurado'}),origin)
        const id=url.searchParams.get('session_id')||''
        if(!/^cs_(test_|live_)[A-Za-z0-9]+$/.test(id))throw fail('Sesión no válida')
        const session=await stripe(env,`/checkout/sessions/${encodeURIComponent(id)}`)
        return withCors(http(200,{paid:session.payment_status==='paid',status:session.status,concept:session.metadata?.concept||''}),origin)
      }
      return withCors(http(404,{error:'Ruta no encontrada'}),origin)
    }catch(e){
      console.error('SDP API:',e.message)
      return withCors(http(e.httpStatus||503,{error:e.httpStatus===409?'No hay suficientes pegatinas disponibles':e.httpStatus===400?e.message:'Servicio temporalmente no disponible'}),origin)
    }
  },
}

export {parseCart,orderDetails,checkoutFields,verifyWebhook,transition,reserve}
