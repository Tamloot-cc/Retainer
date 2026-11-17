import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from spike import POLICY,validate
from cases import build
from engine import bounded_context,keys,pool,publication,request_for,retrieve,url_identity
from run import explain_correct


def body(req,label='same_entity',ref='none',distinct=.01,prob=.96):
    answers=[]
    for q in req['questions']:
        if q['type']=='predicate':answers.append({'name':q['name'],'type':'predicate','probability':distinct});continue
        selected=label if q['name']=='identity' else ref
        n=len(q['choices'])
        answers.append({'name':q['name'],'type':'choice','choice':selected,'confidence':.95,'probabilities':[{'value':c['value'],'probability':prob if c['value']==selected else (1-prob)/(n-1)} for c in q['choices']]})
    return {'model':'gpt-6-luna','answers':answers}


class ContextAndPolicyTests(unittest.TestCase):
    def setUp(self):self.rows=build()
    def test_split_and_unique_stories(self):
        self.assertEqual(len(self.rows),80)
        self.assertEqual(len({r['id'] for r in self.rows}),80)
        for split in ['development','heldout']:
            subset=[r for r in self.rows if r['split']==split]
            self.assertEqual((len(subset),sum(r['duplicate'] for r in subset)),(40,10))
    def test_no_gold_or_scenario_ids_leak(self):
        for row in self.rows:
            req=request_for(row,POLICY);s=json.dumps(req)
            self.assertNotIn(row['id'],s)
            for field in ['gold_support','duplicate','split','cross_story']:
                self.assertNotIn('"'+field+'"',s)
    def test_url_normalization_equivalence(self):
        self.assertEqual(url_identity('http://www.example.org/?utm_source=a'),url_identity('https://example.org'))
        self.assertEqual(url_identity('https://www.linkedin.com/company/a?trk=public_profile'),url_identity('https://linkedin.com/company/a'))
    def test_meaningful_url_identity_preserved(self):
        self.assertNotEqual(url_identity('https://dir.example/?id=1'),url_identity('https://dir.example/?id=2'))
        self.assertNotEqual(url_identity('https://dir.example/Foo'),url_identity('https://dir.example/foo'))
        self.assertNotEqual(url_identity('https://dir.example/a'),url_identity('https://dir.example/b'))
    def test_social_roots_and_credentials_rejected(self):
        for u in ['https://linkedin.com','https://www.linkedin.com/','https://accounts.google.com','https://u:p@example.org','file:///secret','https://example.org:bad']:
            self.assertIsNone(url_identity(u))
    def test_history_states_filtered(self):
        record={'name':'Alpha'}
        for state in ['rejected','retracted','pending_review']:
            self.assertFalse(any(k['historical'] for k in keys(record,[{'field':'email','value':'x@y.example','status':state}],'history')))
        self.assertTrue(any(k['historical'] for k in keys(record,[{'field':'email','value':'x@y.example','status':'superseded'}],'history')))
    def test_context_budget_deterministic_preserves_identifiers(self):
        row=copy.deepcopy(self.rows[0]);row['facts']=[{'ref':f'f{i:03}','text':'padding '*100} for i in range(30)]
        a=bounded_context(row,1600);b=bounded_context(row,1600)
        self.assertEqual(a,b);self.assertEqual(a['records'],row['records'])
        self.assertLessEqual(len(json.dumps(a,ensure_ascii=False,separators=(',',':')).encode()),1600)
        self.assertGreater(a['omitted']['facts'],0)
    def test_overlarge_identity_fields_defer(self):
        row=copy.deepcopy(self.rows[0]);row['records'][0]['name']='x'*10000
        with self.assertRaisesRegex(ValueError,'identity_fields_exceed_budget'):bounded_context(row)
    def test_hebrew_byte_budget(self):
        row=copy.deepcopy(self.rows[0]);row['facts']=[{'ref':'hebrew','text':'ש'*8000}]
        c=bounded_context(row,1000);self.assertEqual(c['facts'],[]);self.assertEqual(c['omitted']['facts'],1)
    def test_no_single_choice_question(self):
        for row in self.rows:
            for q in request_for(row,POLICY)['questions']:
                if q['type']=='choice':self.assertGreaterEqual(len(q['choices']),2)
    def test_normalized_exact_identifiers_support(self):
        row=next(r for r in self.rows if r['id']=='profile_tracking');req=request_for(row,POLICY)
        self.assertTrue(publication(body(req),req,validate)['publish'])
    def test_conflict_and_distinctness_veto(self):
        row=next(r for r in self.rows if r['id']=='copied_all_identifiers');req=request_for(row,POLICY)
        self.assertFalse(publication(body(req,ref='none',distinct=.99),req,validate)['publish'])
    def test_evidence_must_be_allowed_reference(self):
        req=request_for(self.rows[0],POLICY)
        with self.assertRaises(ValueError):publication(body(req,ref='invented'),req,validate)
    def test_wrong_semantic_explanation_counts_as_failure_even_if_duplicate(self):
        row=self.rows[0];self.assertFalse(explain_correct(row,{'publish':True,'explanation':{'template':'sourced_identity','ref':'other_source'}}))
    def test_negative_explanation_always_fails(self):
        row=next(r for r in self.rows if not r['duplicate'])
        self.assertFalse(explain_correct(row,{'publish':True,'explanation':{'template':'exact_profile_website'}}))


class PostgresPoolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db='classifier_spike_'+uuid.uuid4().hex[:12]
        subprocess.run(['docker','exec','docker-postgres-1','createdb','-U','retainer',cls.db],check=True,capture_output=True)
        subprocess.run(['docker','exec','docker-postgres-1','psql','-U','retainer','-d',cls.db,'-c','CREATE EXTENSION pg_trgm'],check=True,capture_output=True)
    @classmethod
    def tearDownClass(cls):subprocess.run(['docker','exec','docker-postgres-1','dropdb','-U','retainer',cls.db],check=True,capture_output=True)
    def records(self):
        c=copy.deepcopy(build()[1]);return pool([c])
    def test_historical_identifier_recovers_pair(self):
        records=self.records();records[0]['record']['name']='QX';records[1]['record']['name']='BZ';records[0]['name']='QX';records[1]['name']='BZ'
        self.assertEqual(retrieve(records,'current',self.db)['total_candidates'],0)
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],1)
    def test_workspace_isolation(self):
        records=self.records();records[1]['workspace']='other'
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_object_isolation(self):
        records=self.records();records[1]['object']='person'
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_dead_record_excluded(self):
        records=self.records();records[1]['live']=False
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_event_object_excluded(self):
        records=self.records()
        for r in records:r['object']='event'
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_social_host_regression(self):
        c=next(c for c in build() if c['id']=='social_host_only');records=pool([c])
        self.assertEqual(retrieve(records,'host',self.db)['total_candidates'],1)
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_pending_history_does_not_create_candidate(self):
        records=self.records()
        for i,r in enumerate(records):
            r['name']='QX' if i==0 else 'BZ';r['record']={'name':r['name']};r['history']=[{'field':'website','value':'https://shared.example','status':'pending_review'}]
        self.assertEqual(retrieve(records,'history',self.db)['total_candidates'],0)
    def test_canonical_unique_pairs_and_cross_story_matches(self):
        records=self.records();records.append({**copy.deepcopy(records[0]),'id':'third'})
        found=retrieve(records,'history',self.db)
        pairs=[(c['a'],c['b']) for c in found['candidates']]
        self.assertEqual(len(pairs),len(set(pairs)));self.assertTrue(all(a<b for a,b in pairs));self.assertEqual(len(pairs),3)
    def test_cap_reports_unprocessed_candidates(self):
        records=self.records();records.append({**copy.deepcopy(records[0]),'id':'third'})
        found=retrieve(records,'history',self.db,cap=1)
        self.assertTrue(found['capped']);self.assertEqual(len(found['candidates']),1);self.assertEqual(found['total_candidates'],3)

if __name__=='__main__':unittest.main()
