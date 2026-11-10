export const dynamic='force-dynamic';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {getSession} from '#lib/http/session.js';
import {getOnboardingSession} from '#lib/security/oidc-onboarding.js';
import ProfileForm from './form.js';
export default function Onboarding(){
 const user=getSession();if(user)redirect(user.role==='provider'?'/provider/dashboard':'/');
 const jar=cookies();let pending;
 try{pending=getOnboardingSession({headers:{get:name=>name==='cookie'?jar.toString():null}});}catch{pending=null;}
 if(!pending)redirect('/login');
 return <div style={{maxWidth:480}}><h1>Complete your profile</h1><p>Signed in as {pending.email}</p><ProfileForm/></div>;
}
