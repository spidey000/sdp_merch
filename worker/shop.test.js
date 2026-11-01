import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import worker, {parseCart,orderDetails,checkoutFields,transition,reserve} from './index.js'

function makeDB(){
  const db=new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('migrations/0001_initial.sql',import.meta.url),'utf8'))
  const wrap=sql=>({bind(...params){return {
    first:async()=>db.prepare(sql).get(...params),
    all:async()=>({results:db.prepare(sql).all(...params)}),
    run:async()=>({meta:{changes:db.prepare(sql).run(...params).changes}}),
    _sql:sql,_params:params
  }}})
  return {
    prepare:wrap,
    batch:async(statements)=>{
      db.exec('BEGIN')
      try{
        const results=statements.map(s=>({meta:{changes:db.prepare(s._sql).run(...s._params).changes}}))
        db.exec('COMMIT')
        return results
      }catch(e){db.exec('ROLLBACK');throw e}
    },
    query:sql=>db.prepare(sql).get(),
  }
}

test('1000 physical stickers -> 333 packs, 1 leftover',async()=>{
  const db=makeDB()
  assert.equal(Math.floor(db.query("SELECT available AS n FROM inventory").n/3),333)
  await reserve(db,'a',999)
  assert.equal(db.query('SELECT available AS n FROM inventory').n,1)
  await assert.rejects(reserve(db,'b',3),/suficientes/)
  await transition(db,'a','paid')
  await transition(db,'a','paid')
  assert.equal(db.query('SELECT available AS n FROM inventory').n,1)
})

test('expired and failed orders restore stock once only',async()=>{
  const db=makeDB()
  await reserve(db,'c',6)
  await transition(db,'c','released')
  await transition(db,'c','released')
  assert.equal(db.query('SELECT available AS n FROM inventory').n,1000)
})
test('cannot release already paid reservations',async()=>{
  const db=makeDB()
  await reserve(db,'d',3)
  await transition(db,'d','paid')
  await transition(db,'d','released')
  assert.equal(db.query('SELECT available AS n FROM inventory').n,997)
})
test('server-side cart pricing and payment methods',()=>{
  assert.deepEqual(parseCart({Q:2,Y:1}),{Q:2,Y:1})
  const info=orderDetails(parseCart({L:1,Q:3}))
  assert.equal(info.cents,800)
  assert.equal(info.stickerCount,9)
  assert.equal(info.concept,'SDP MERCH L1 Q3')
  const form=checkoutFields(info,'reservation')
  assert.deepEqual(form.getAll('payment_method_types[0]'),['card'])
  assert.equal(form.get('payment_method_types[1]'),'bizum')
  assert.throws(()=>parseCart({Q:2.4}))
})
test('worker stock endpoint, checkout rejects when Stripe secrets absent',async()=>{
  const DB=makeDB()
  const stock=await worker.fetch(new Request('https://api.example.com/api/stock',{headers:{origin:'https://spidey000.github.io'}}),{DB})
  assert.equal(stock.status,200)
  assert.deepEqual((await stock.json()),{ready:false,remaining:1000,packs:333,initial:1000})
  const checkout=await worker.fetch(new Request('https://api.example.com/api/checkout',{method:'POST',headers:{origin:'https://spidey000.github.io','content-type':'application/json'},body:JSON.stringify({cart:{Q:1}})}),{DB})
  assert.equal(checkout.status,503)
  assert.equal(DB.query('SELECT available AS n FROM inventory').n,1000)
})
test('create Stripe checkout, reserve 3 units, paid webhook does not double-count',async()=>{
  const DB=makeDB()
  const env={DB,STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake'}
  const oldFetch=globalThis.fetch
  globalThis.fetch=async (url,options)=>{
    assert.equal(url,'https://api.stripe.com/v1/checkout/sessions')
    const fields=new URLSearchParams(options.body)
    assert.equal(fields.get('payment_method_types[1]'),'bizum')
    assert.equal(fields.get('line_items[0][price_data][unit_amount]'),'100')
    assert.equal(fields.get('line_items[0][quantity]'),'1')
    const rid=fields.get('client_reference_id')
    assert.match(rid,/^[0-9a-f-]{36}$/)
    return new Response(JSON.stringify({id:'cs_test_fake123',url:'https://checkout.stripe.com/c/pay/cs_test_fake123',expires_at:Math.floor(Date.now()/1000)+1800}),{status:200,headers:{'content-type':'application/json'}})
  }
  try {
    const request=new Request('https://api.example.com/api/checkout',{method:'POST',headers:{origin:'https://spidey000.github.io','content-type':'application/json'},body:JSON.stringify({cart:{Q:1}})})
    const response=await worker.fetch(request,env)
    assert.equal(response.status,200)
    assert.equal((await response.json()).concept,'SDP MERCH Q1')
    assert.equal(DB.query('SELECT available AS n FROM inventory').n,997)
    const reservation=DB.query('SELECT id FROM reservations LIMIT 1')
    const eventBody=JSON.stringify({type:'checkout.session.completed',data:{object:{payment_status:'paid',metadata:{reservation_id:reservation.id}}}})
    const time=Math.floor(Date.now()/1000)
    const signature=createHmac('sha256','whsec_fake').update(`${time}.${eventBody}`).digest('hex')
    for(let repeat=0;repeat<2;repeat++){
      const hook=new Request('https://api.example.com/api/stripe-webhook',{method:'POST',headers:{'stripe-signature':`t=${time},v1=${signature}`},body:eventBody})
      const result=await worker.fetch(hook,env)
      assert.equal(result.status,200)
    }
    await transition(DB,reservation.id,'released')
    assert.equal(DB.query('SELECT available AS n FROM inventory').n,997)
  }finally {globalThis.fetch=oldFetch}
})
