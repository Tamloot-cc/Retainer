"""Replay frozen Decisions outputs with the real merged URL comparator."""
import json
from pathlib import Path
from matrix import plan,assessment
from runtime import validate
from url_parity import production_keys,COMMIT
ROOT=Path(__file__).parent


def replay():
    jobs=plan();results={r['id']:r for r in [json.loads(line) for line in (ROOT/'results/evaluations.jsonl').read_text().splitlines()]}
    urls=sorted({r[k] for j in jobs for r in json.loads(j['request']['input'])['records'] for k in ['website','linkedin'] if isinstance(r.get(k),str)})
    lookup=dict(zip(urls,production_keys(urls)));changes=[]
    for job in jobs:
        result=results[job['id']]['result']
        if not result['ok']:continue
        body=result['attempts'][-1]['body'];answers=validate(body,job['request']);data=json.loads(job['request']['input']);a,b=data['records']
        ap,bp=[lookup.get(r.get('linkedin')) for r in [a,b]];aw,bw=[lookup.get(r.get('website')) for r in [a,b]]
        exact=bool(ap and ap==bp and ap.startswith('linkedin.com/company/') and aw and aw==bw)
        conflict=bool(ap and bp and ap!=bp);identity=answers['identity'];same=next(p['probability'] for p in identity['probabilities'] if p['value']=='same_entity')
        reference=answers.get('identity_evidence',{}).get('choice','none');semantic=reference!='none' and reference in {f['ref'] for f in data.get('facts',[])}
        production=bool(identity['choice']=='same_entity' and same>=.9 and (exact or semantic) and answers['explicit_distinct']['probability']<.1 and not conflict)
        prototype=assessment(body,job['request'],False)['publish']
        if production!=prototype:changes.append({'id':job['id'],'prototype_publication':prototype,'production_normalized_publication':production})
    output={'production_commit':COMMIT,'unique_urls':len(urls),'responses_replayed':sum(results[j['id']]['result']['ok'] for j in jobs),'publication_changes':len(changes),'details':changes,'note':'This replays the experimental publication gate; the production server does not implement a classifier.'}
    (ROOT/'results/normalization-replay.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(output))

if __name__=='__main__':replay()
