import {SHOP,API_VERSION,type Request} from './commerce-finalization';

/** A narrow adapter around the existing Admin GraphQL transport. Its transport must
 * include token acquisition inside the absolute deadline and return the full envelope.
 * No credentials, provider error text, URL, or customer data is returned by this module. */
export interface AdminTransport {
 now():number;
 graphql(query:string,variables:Record<string,unknown>,options:{shopDomain:typeof SHOP;apiVersion:typeof API_VERSION;deadline:number;mutation:true;retry:false}):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const payloadName:Record<string,string>={commerce:'productVariantsBulkUpdate',activate_location:'inventoryActivate',set_stock:'inventorySetQuantities',publish_variant:'publishablePublish',activate_product:'productUpdate',publish_product:'publishablePublish'};
export async function sendCommercialRequest(transport:AdminTransport,request:Request,deadline:number):Promise<void>{
 if(!Number.isFinite(deadline)||deadline<=transport.now())throw new Error('FINALIZE_TIME_BUDGET');
 if(request.apiVersion!==API_VERSION||!Object.hasOwn(payloadName,request.operation))throw new Error('FINALIZE_REQUEST_INVALID');
 // The exact request must be the durable beginNextStep output, matched by its SQL
 // receipt. This adapter is never exposed as a general browser GraphQL endpoint.
 const value=await transport.graphql(request.query,request.variables,{shopDomain:SHOP,apiVersion:API_VERSION,deadline,mutation:true,retry:false});
 if(!object(value)||('errors'in value&&(!Array.isArray(value.errors)||value.errors.length!==0))||!object(value.data))throw new Error('FINALIZE_SHOPIFY_RESPONSE_INVALID');
 const payload=value.data[payloadName[request.operation]];
 if(!object(payload)||!Array.isArray(payload.userErrors)||payload.userErrors.length!==0)throw new Error('FINALIZE_SHOPIFY_MUTATION_UNCONFIRMED');
 // Success only means a well-formed response; the worker independently reads back.
}
