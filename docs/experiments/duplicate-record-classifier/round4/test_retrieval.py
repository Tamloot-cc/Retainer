import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parent))
from corpus import build
from retrieval import source_pool,fact_mentions
from run import digest
from spike import POLICY
from engine import request_for


class FactMentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db='classifier_facts_'+uuid.uuid4().hex[:12]
        subprocess.run(['docker','exec','docker-postgres-1','createdb','-U','retainer',cls.db],check=True,capture_output=True)
    @classmethod
    def tearDownClass(cls):subprocess.run(['docker','exec','docker-postgres-1','dropdb','-U','retainer',cls.db],check=True,capture_output=True)
    def sample(self):return source_pool([build()[0]])
    def query(self,records,facts,**kwargs):return fact_mentions(records,facts,self.db,**kwargs)
    def test_finds_former_full_name_without_history(self):
        records,facts=self.sample();result=self.query(records,facts)
        self.assertEqual(len(result['candidates']),1)
        self.assertEqual(result['candidates'][0]['triggers'][0]['references'][0]['source_ref'],'source_1')
    def test_source_may_be_weak_retrieval_does_not_publish(self):
        case=next(c for c in build() if c['id']=='ownership_mention');r,f=source_pool([case])
        self.assertEqual(len(self.query(r,f)['candidates']),1)
    def test_requires_full_phrase_not_shared_first_name(self):
        c=next(c for c in build() if c['id']=='missing_identifier_in_excerpt');r,f=source_pool([c])
        self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_workspace_boundary(self):
        r,f=self.sample();r[0]['workspace']='other'
        self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_owner_fact_workspace_boundary(self):
        r,f=self.sample();f[0]['workspace']='other'
        self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_object_boundary(self):
        r,f=self.sample();r[0]['object']='person'
        self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_hidden_or_dead_sources_excluded(self):
        for flag in ['source_live','visible','current']:
            r,f=self.sample();f[0][flag]=False
            self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_deleted_owner_or_candidate_excluded(self):
        for i in [0,1]:
            r,f=self.sample();r[i]['live']=False
            self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_unknown_source_owner_excluded(self):
        r,f=self.sample();f[0]['owner']='missing'
        self.assertEqual(len(self.query(r,f)['candidates']),0)
    def test_copied_sources_do_not_duplicate_pairs(self):
        r,f=self.sample();f.extend([{**copy.deepcopy(f[0]),'id':'copy-'+str(i)} for i in range(5)])
        self.assertEqual(len(self.query(r,f)['candidates']),1)
    def test_owner_budget_reports_unprocessed_matches(self):
        r,f=self.sample();owner=r[1]
        r.extend([{'id':'extra-'+str(i),'workspace':owner['workspace'],'object':owner['object'],'live':True,'name':n,'query_name':n.lower()} for i,n in enumerate(['Copper Finch','Copper Flock'])])
        f[0]['content']+=' Copper Finch and Copper Flock are mentioned too.'
        result=self.query(r,f,per_owner=1)
        self.assertEqual(result['owner_candidates_before_cap'],3);self.assertEqual(result['owner_candidates_deferred'],2);self.assertEqual(len(result['candidates']),1)
    def test_global_cap_reports_deferred_pairs(self):
        r,f=source_pool(build()[:4]);result=self.query(r,f,cap=1)
        self.assertEqual(len(result['candidates']),1);self.assertGreater(result['globally_deferred'],0)
    def test_phrase_mention_hebrew(self):
        case=next(c for c in build() if c['id']=='bilingual_entity');r,f=source_pool([case]);self.assertEqual(len(self.query(r,f)['candidates']),1)
    def test_retrieval_trigger_does_not_enter_model_prompt(self):
        for case in build():
            request=json.dumps(request_for(case,POLICY),ensure_ascii=False)
            for name in ['fact_owner','gold_support','duplicate','split']:
                self.assertNotIn('"'+name+'"',request)
            self.assertNotIn(case['id'],request)
    def test_protocol_hashes_still_match(self):
        protocol=json.loads((Path(__file__).with_name('results')/'protocol.json').read_text())
        self.assertEqual(protocol['dataset_sha256'],digest(build()))
        self.assertEqual(protocol['requests_sha256'],digest([request_for(c,POLICY) for c in build()]))

if __name__=='__main__':unittest.main()
