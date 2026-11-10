'use client';
import {useState} from 'react';
export default function ProfileForm(){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <form className="panel" onSubmit={async event=>{
  event.preventDefault();setBusy(true);setError('');
  try{const fields=Object.fromEntries(new FormData(event.currentTarget));const result=await fetch('/api/auth/keycloak/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)});const data=await result.json();if(!result.ok)throw new Error(data.error||'Unable to save profile');window.location.href=data.redirectTo;}
  catch(error){setError(error.message);setBusy(false);}
 }}>
  <label>Account type<select name="role" required><option value="customer">Customer</option><option value="provider">Provider</option></select></label>
  <label>Name<input name="name" required maxLength={120}/></label>
  <label>Phone (optional)<input name="phone" maxLength={40}/></label>
  <label>Company (providers only, optional)<input name="company_name" maxLength={160}/></label>
  <p>Providers require administrator approval before offering services.</p>
  <button disabled={busy}>{busy?'Saving…':'Create profile'}</button>{error?<p className="err">{error}</p>:null}
 </form>;
}
