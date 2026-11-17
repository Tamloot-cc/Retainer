"""Bounded authorized Team8 shadow evaluation. Real data stays outside the repo.
Uses an existing API key and OpenAI credential; makes no CRM writes.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlencode,urlsplit
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from spike import POLICY,transport,validate
from engine import pool,retrieve,request_for,publication
from paths import checkout_roots

WORKSPACE='b3120bbd-4d14-44e8-a06b-d6c6a4d0dc00'


def env_file(path):
    text=Path(path).read_text();values={}
    for name in ['RETAINER_AWS_APP_URL','RETAINER_AWS_API_KEY']:
        match=re.search(r'^'+name+r'\s*=\s*(.+)',text,re.M)
        if not match:raise ValueError('Missing configured Retainer credential')
        values[name]=match.group(1).strip().strip('\"\x27')
    return values


def private_write(path,data):
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)


def opaque(id):return 'r-'+hashlib.sha256(id.encode()).hexdigest()[:20]


def links(value):
    if not isinstance(value,dict):return []
    return [x['url'] for x in [value.get('primary')]+value.get('additional',[]) if isinstance(x,dict) and isinstance(x.get('url'),str)]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--env-file',required=True);parser.add_argument('--private-dir',required=True);parser.add_argument('--live',action='store_true');args=parser.parse_args()
    directory=Path(args.private_dir).resolve()
    roots=checkout_roots(__file__)
    if any(directory==root or root in directory.parents for root in roots):raise SystemExit('Real data must remain outside every repository checkout')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True);directory.chmod(0o700)
    if (directory/'shadow-results.json').exists():raise SystemExit('Existing shadow results are immutable; choose a new private directory')
    cfg=env_file(args.env_file);u=urlsplit(cfg['RETAINER_AWS_APP_URL']);origin=u.scheme+'://'+u.netloc
    audit=[]
    def read(path,body=None):
        allowed=path in ['/v1/me','/v1/schema','/v1/objects/company/query'] or bool(re.fullmatch(r'/v1/records/[0-9a-f-]+/(assertions\?field=(name|domain|linkedinUrl)&limit=200|facts\?limit=50)',path))
        if not allowed or (body is not None and path!='/v1/objects/company/query'):raise ValueError('Read allowlist rejected route')
        request=urllib.request.Request(origin+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+cfg['RETAINER_AWS_API_KEY'],'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=30) as response:data=json.load(response)
        audit.append({'method':request.get_method(),'route':re.sub(r'/[0-9a-f-]{36}/','/<record>/',path),'status':200})
        return data
    me=read('/v1/me')
    if me['workspace']['id']!=WORKSPACE or me['workspace']['name']!='Team8' or 'read' not in me['scopes']:raise SystemExit('Expected authorized Team8 read access')
    data=read('/v1/objects/company/query',{'limit':200,'sort':[{'field':'id','direction':'asc'}]})
    raw=data['records'];raw=raw[:200]
    records=[];histories={};facts={};page_omissions=0
    # Snapshot only identity fields; unrelated company data is never retained or forwarded.
    for r in raw:
        identity={'id':opaque(r['id']),'name':r['fields'].get('name') or r.get('label') or ''}
        for field,target in [('domain','website'),('linkedinUrl','linkedin')]:
            urls=links(r['fields'].get(field))
            if urls:identity[target]=urls[0]
        records.append({'id':identity['id'],'workspace':WORKSPACE,'object':'company','live':True,'name':identity['name'],'record':identity,'history':[]})
    def history_job(item):
        original,record=item;history=[];identity_facts=[];omitted=0
        for field,target in [('name','name'),('domain','website'),('linkedinUrl','linkedin')]:
            page=read(f"/v1/records/{original['id']}/assertions?field={field}&limit=200")
            omitted+=int(bool(page.get('nextCursor')))
            for a in page.get('items',[]):
                values=[a['value']] if field=='name' and isinstance(a.get('value'),str) else links(a.get('value'))
                for value in values:
                    history.append({'field':target,'value':value,'status':a['status'],'ref':'assertion_'+opaque(a['id']),'observed_at':a['observedAt']})
        page=read(f"/v1/records/{original['id']}/facts?limit=50")
        omitted+=int(bool(page.get('nextCursor')))
        # Bounded literal selection: no transcripts or external research; no generated summaries.
        for f in page.get('facts',[]):
            content=f.get('content','')
            if re.search(r'formerly|renam|rebrand|alias|registration|legal entity|same company|same entity|previous (name|domain)|trading (as|name)|subsidiar|acqui',content,re.I):
                identity_facts.append({'ref':'fact_'+opaque(f['id']),'text':content[:1200],'origin':'workspace_fact','observed_at':f.get('createdAt',''),'text_truncated':len(content)>1200})
        return record['id'],history,identity_facts[:8],omitted
    with ThreadPoolExecutor(max_workers=4) as workers:
        for id,history,identity_facts,omitted in workers.map(history_job,zip(raw,records)):
            histories[id]=history;facts[id]=identity_facts;page_omissions+=omitted
    for record in records:record['history']=histories[record['id']]
    retrieval={mode:retrieve(records,mode,cap=200) for mode in ['host','current','history']}
    # Evaluate all history candidates first, then a bounded sample of legacy-host-only pairs.
    selected={}
    for mode in ['history','host']:
        for c in retrieval[mode]['candidates']:
            selected.setdefault((c['a'],c['b']),c)
            if len(selected)>=20:break
        if len(selected)>=20:break
    record_map={r['id']:r for r in records}
    pairs=[]
    for left,right in selected:
        pairs.append({'id':'pair-'+hashlib.sha256((left+right).encode()).hexdigest()[:12],'kind':'company',
                      'records':[record_map[left]['record'],record_map[right]['record']],
                      'history':[histories[left],histories[right]],'facts':list({f['ref']:f for f in facts[left]+facts[right]}.values())})
    requests=[request_for(case,POLICY) for case in pairs]
    reserve=sum(len(json.dumps(r).encode())+1024 for r in requests)*2*.125/1e6
    if reserve>.25:raise SystemExit('Shadow spend reservation exceeds $0.25')
    private_write(directory/'snapshot.json',{'workspace':WORKSPACE,'records':records,'facts':facts,'page_omissions':page_omissions,'has_more_companies':bool(data.get('nextCursor'))})
    private_write(directory/'shadow-plan.json',{'pairs':pairs,'requests':requests,'retrieval':retrieval,'reserved_usd':reserve})
    results=[]
    if args.live:
        key=os.environ.get('OPENAI_API_KEY')
        if not key:raise SystemExit('Existing operator OpenAI credential required')
        for case,request in zip(pairs,requests):
            result=transport(request,key);row={'id':case['id'],'result':result}
            if result['ok']:row['publication']=publication(result['attempts'][-1]['body'],request,validate,.9)
            results.append(row)
            # Private checkpoint, including partial provider results after an interruption.
            private_write(directory/'shadow-results.json',results)
    private_write(directory/'read-audit.json',audit)
    normal={tuple(sorted((c['a'],c['b']))) for c in retrieval['history']['candidates']}
    by_pair={case['id']:tuple(sorted(r['id'] for r in case['records'])) for case in pairs}
    live_count=sum(r['result']['ok'] for r in results)
    labels={}
    for r in results:
        if r['result']['ok']:
            label=r['result']['attempts'][-1]['body']['answers'][0]['choice'];labels[label]=labels.get(label,0)+1
    usage=sum(a.get('body',{}).get('usage',{}).get('input_tokens',0) for r in results for a in r['result']['attempts'])
    summary={'workspace':'Team8','captured_at':datetime.now(timezone.utc).isoformat(),'companies':len(records),'has_more_companies':bool(data.get('nextCursor')),'history_items':sum(map(len,histories.values())),'identity_facts':sum(map(len,facts.values())),'page_omissions':page_omissions,'candidates':{m:r['total_candidates'] for m,r in retrieval.items()},'selected_pairs':len(pairs),'live_requests':len(results),'successful_requests':live_count,'outcomes':labels,'eligible_if_classified':sum(r.get('publication',{}).get('publish',False) for r in results),'eligible_on_actual_history_candidates':sum(r.get('publication',{}).get('publish',False) and by_pair[r['id']] in normal for r in results),'input_tokens':usage,'estimated_uncached_usd':usage*.1/1e6,'read_api_requests':len(audit),'crm_writes':0,'visible_suggestions_created':0,'real_data_committed':False,'quality_verdict':'unlabeled shadow sample; no accuracy or recall claim'}
    private_write(directory/'shadow-summary.json',summary)
    print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
