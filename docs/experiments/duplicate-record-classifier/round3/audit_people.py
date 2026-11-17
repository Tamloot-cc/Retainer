"""Read-only candidate audit, no provider calls and no inferred duplicate labels."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'round2'))
from engine import retrieve
from shadow import WORKSPACE,env_file,private_write
from paths import checkout_roots


def candidate_pool(snapshot):
    records=[];additional=0
    for row in snapshot['records']:
        fields=row['fields'];name=fields.get('name',{})
        label=' '.join(str(name.get(k) or '') for k in ['first','last']).strip() or row.get('label','')
        record={'id':row['id'],'name':label};aliases=[]
        for field,target in [('emails','email'),('phones','phone')]:
            values=fields.get(field,{})
            if not isinstance(values,dict):continue
            for i,value in enumerate([values.get('primary')]+values.get('additional',[])):
                value=value.get('number') if isinstance(value,dict) else value
                if not value:continue
                if i==0:record[target]=value
                else:aliases.append({'field':target,'value':value,'status':'active','ref':'additional_'+target+str(i)});additional+=1
        records.append({'id':row['id'],'workspace':WORKSPACE,'object':'person','live':True,'name':label,'record':record,'history':aliases})
    return records,additional


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--private-dir',required=True);parser.add_argument('--fetch',action='store_true');parser.add_argument('--env-file');args=parser.parse_args()
    directory=Path(args.private_dir).resolve();roots=checkout_roots(__file__)
    if any(directory==r or r in directory.parents for r in roots):raise SystemExit('Private evidence must stay outside every checkout')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True);directory.chmod(0o700)
    path=directory/'people.json'
    if args.fetch:
        if path.exists():raise SystemExit('Snapshot exists; choose a fresh private directory')
        if not args.env_file:raise SystemExit('An explicit operator env-file is required')
        cfg=env_file(args.env_file);u=urlsplit(cfg['RETAINER_AWS_APP_URL']);origin=u.scheme+'://'+u.netloc
        headers={'Authorization':'Bearer '+cfg['RETAINER_AWS_API_KEY'],'Content-Type':'application/json'}
        with urllib.request.urlopen(urllib.request.Request(origin+'/v1/me',headers=headers),timeout=20) as r:me=json.load(r)
        if me['workspace']['id']!=WORKSPACE or me['workspace']['name']!='Team8' or 'read' not in me['scopes']:raise SystemExit('Expected authorized Team8 read credential')
        request=urllib.request.Request(origin+'/v1/objects/person/query',data=json.dumps({'limit':187,'sort':[{'field':'id','direction':'asc'}]}).encode(),headers=headers)
        with urllib.request.urlopen(request,timeout=30) as response:data=json.load(response)
        # Retain identity fields only. No private memory endpoints or source transcripts.
        minimal=[{k:v for k,v in r.items() if k in ['id','object','label','createdAt','updatedAt']}|{'fields':{k:v for k,v in r['fields'].items() if k in ['name','emails','phones','company']}} for r in data['records']]
        private_write(path,{'records':minimal,'has_more':bool(data.get('nextCursor'))})
    snapshot=json.loads(path.read_text());records,additional=candidate_pool(snapshot)
    primary=retrieve(records,'current');all_identifiers=retrieve(records,'history')
    private_write(directory/'all-current-candidates.json',all_identifiers)
    summary={'workspace':'Team8','analyzed_at':datetime.now(timezone.utc).isoformat(),'person_records':len(records),'has_more':snapshot['has_more'],'additional_email_phone_values':additional,'primary_candidates':primary['total_candidates'],'all_current_candidates':all_identifiers['total_candidates'],'crm_writes':0,'provider_calls':0,'known_positive_labels':None,'quality_verdict':'Candidate audit only. Matching identifiers would require independent adjudication; no real recall claim.'}
    private_write(directory/'audit-summary.json',summary)
    print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
