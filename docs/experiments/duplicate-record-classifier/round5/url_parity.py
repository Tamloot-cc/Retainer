"""Compare the spike comparator to the actual merged production helper, read-only."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'round2'))
from engine import url_identity
from paths import repository_root
ROOT=Path(__file__).parent
PRODUCTION=repository_root(__file__)/'packages/server/src/records/derive.ts'
COMMIT='c4b979677187aa1df290a3ff28adb9a920b043ff'
PAIRS=[
 ('scheme_root','http://www.cobalt.example/','https://cobalt.example',True),
 ('protocol_relative','//cobalt.example/path','https://cobalt.example/path',True),
 ('host_case','https://WWW.COBALT.EXAMPLE','https://cobalt.example/',True),
 ('profile_slash','https://linkedin.com/company/cobalt/','https://linkedin.com/company/cobalt',True),
 ('person_profile_slash','https://linkedin.com/in/person/','https://linkedin.com/in/person',True),
 ('school_profile_slash','https://linkedin.com/school/example/','https://linkedin.com/school/example',True),
 ('path_case','https://example.org/Alpha','https://example.org/alpha',False),
 ('query_ids','https://dir.example/?id=1','https://dir.example/?id=2',False),
 ('query_encoding','https://dir.example/?id=a%20b','https://dir.example/?id=a+b',False),
 ('encoded_tilde','https://dir.example/?id=~','https://dir.example/?id=%7E',False),
 ('hash_routes','https://app.example/#/company/1','https://app.example/#/company/2',False),
 ('http_nondefault443','http://example.org:443/','https://example.org/',False),
 ('https_nondefault80','https://example.org:80/','https://example.org/',False),
 ('nondefault_port','https://example.org:8443/','https://example.org/',False),
 ('default_ports','http://example.org:80/','https://example.org:443/',True),
 ('linkedin_referral','https://linkedin.com/company/cobalt?trk=abc','https://linkedin.com/company/cobalt',True),
 ('other_trk_identity','https://dir.example/?trk=1','https://dir.example/?trk=2',False),
 ('unknown_param','https://dir.example/?ref=one','https://dir.example/?ref=two',False),
 ('li_fat_id_preserved','https://linkedin.com/company/cobalt?li_fat_id=one','https://linkedin.com/company/cobalt?li_fat_id=two',False),
 ('msclkid_tracking','https://example.org/?msclkid=abc','https://example.org/',True),
 ('utm_tracking','https://example.org/?utm_source=a&utm_medium=b','https://example.org/',True),
 ('fbclid_tracking','https://example.org/?fbclid=abc','https://example.org/',True),
 ('preserve_query_after_tracking','https://dir.example/?id=a%20b&utm_source=crm','https://dir.example/?id=a%20b',True),
 ('empty_query_separators','https://example.org/?&','https://example.org/',True),
 ('social_root','https://linkedin.com','https://www.linkedin.com/',False),
 ('github_root','https://github.com','https://github.com/',False),
 ('youtube_root','https://youtube.com/','https://youtube.com',False),
 ('docs_google_root','https://docs.google.com','https://docs.google.com/',False),
 ('accounts_google_root','https://accounts.google.com','https://accounts.google.com/',False),
 ('social_path_distinct','https://linkedin.com/company/fijoya','https://linkedin.com/company/wiz',False),
 ('github_user','https://github.com/cobalt','https://www.github.com/cobalt',True),
 ('arbitrary_trailing_slash','https://dir.example/a/','https://dir.example/a',False),
 ('whitespace','  https://example.org/path  ','https://example.org/path',True),
 ('credentials','https://user:pass@example.org','https://example.org/',False),
 ('ftp','ftp://example.org','https://example.org/',False),
 ('root_websites','https://ordinary.example','https://ordinary.example/',True),
 ('subdomains','https://a.example.org','https://b.example.org',False),
 ('root_query_identity','https://ordinary.example/?tenant=one','https://ordinary.example/?tenant=two',False),
 ('empty_value','https://dir.example/?id=','https://dir.example/',False),
 ('repeated_query_values','https://dir.example/?id=1&id=2','https://dir.example/?id=2&id=1',False),
]


def production_keys(urls):
    expected=subprocess.check_output(['git','show',COMMIT+':packages/server/src/records/derive.ts'],cwd=PRODUCTION.parents[4])
    if PRODUCTION.read_bytes()!=expected:raise RuntimeError('Production helper differs from pinned merged commit; re-pin explicitly')
    code='import {duplicateUrlKey} from '+json.dumps(PRODUCTION.as_uri())+'; let input=""; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(JSON.stringify(JSON.parse(input).map(duplicateUrlKey)));'
    r=subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',code],input=json.dumps(urls),text=True,capture_output=True,check=True)
    return json.loads(r.stdout)


def same(a,b):return bool(a and b and a==b)


def main():
    urls=[u for _,a,b,_ in PAIRS for u in [a,b]];keys=production_keys(urls);rows=[]
    for i,(name,a,b,expected) in enumerate(PAIRS):
        prod=same(keys[i*2],keys[i*2+1]);prototype=same(url_identity(a),url_identity(b))
        rows.append({'name':name,'urls':[a,b],'expected_match':expected,'production_match':prod,'prototype_match':prototype,'production_keys':keys[i*2:i*2+2],'prototype_keys':[url_identity(a),url_identity(b)],'production_pass':prod==expected,'prototype_pass':prototype==expected,'parity':prod==prototype})
    data={'commit':COMMIT,'source_sha256':hashlib.sha256(PRODUCTION.read_bytes()).hexdigest(),'pairs':len(rows),'production_passed':sum(r['production_pass'] for r in rows),'prototype_passed':sum(r['prototype_pass'] for r in rows),'parity_disagreements':[r for r in rows if not r['parity']],'production_failures':[r for r in rows if not r['production_pass']],'results':rows}
    out=ROOT/'results';out.mkdir(exist_ok=True);(out/'url-parity.json').write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps({k:v for k,v in data.items() if k not in ['results','parity_disagreements']}|{'parity_disagreement_count':len(data['parity_disagreements'])},indent=2))

if __name__=='__main__':main()
