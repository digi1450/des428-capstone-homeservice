#!/usr/bin/env python3
"""Disposable test realm only. Never modifies the shared realm or any useful user data."""
import json, pathlib, sys
root=pathlib.Path(__file__).resolve().parents[2]
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
r=json.loads((root/'infra/keycloak/homeservice-realm.json').read_text())
r['revokeRefreshToken']=True;r['refreshTokenMaxReuse']=0
r['users']=[]
for client in r['clients']:
 if client['clientId']=='homeservice-web':
  client['redirectUris']=['https://127.0.0.1:3443/api/auth/keycloak/callback'];client['webOrigins']=['https://127.0.0.1:3443']
 if client['clientId'] in ['booking-service','mock-gateway-service']:client['secret']='disposable-'+client['clientId']
for number,name in enumerate(['alice','bob','provider','unmapped'],1):
 r['users'].append({'id':f'11111111-1111-4111-8111-{number:012d}','username':name,'email':name+'@example.test','emailVerified':True,'firstName':name,'lastName':'Fixture','enabled':True,'requiredActions':[], 'credentials':[{'type':'password','value':'Disposable-password-1!','temporary':False}], 'clientRoles':{'notifications-service':['user:read'],'payments-wallet-service':['user:read']}})
for name,roles in [('booking-service',['booking:'+x for x in ['create','query','cancel','activate','complete_financial','cancel_financial','query_financial']]),('mock-gateway-service',['mock-gateway:settle_webhook'])]:
 r['users'].append({'username':'service-account-'+name,'enabled':True,'serviceAccountClientId':name,'clientRoles':{'payments-wallet-service':roles}})
(out/'homeservice-realm.json').write_text(json.dumps(r))
