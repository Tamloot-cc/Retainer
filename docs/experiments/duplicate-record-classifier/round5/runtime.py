"""Fail-closed spike transport. Synthetic inputs only; no production imports."""
import json
from email.utils import parsedate_to_datetime
from datetime import datetime,timezone
import math
import threading
import time
import urllib.error
import urllib.request


class InvalidDecision(ValueError):pass


def number(value):return type(value) in (int,float) and math.isfinite(value)


def validate(body,request):
    if not isinstance(body,dict):raise InvalidDecision('response_object')
    if body.get('model')!=request['model']:raise InvalidDecision('model_mismatch')
    answers=body.get('answers')
    if not isinstance(answers,list) or len(answers)!=len(request['questions']):raise InvalidDecision('answer_count')
    for q,a in zip(request['questions'],answers):
        if not isinstance(a,dict):raise InvalidDecision('answer_object')
        if a.get('name')!=q['name']:raise InvalidDecision('question_name')
        if a.get('type')=='refusal':raise InvalidDecision('refusal')
        if a.get('type')!=q['type']:raise InvalidDecision('answer_type')
        if q['type']=='predicate':
            if not number(a.get('probability')) or not 0<=a['probability']<=1:raise InvalidDecision('predicate_probability')
        elif q['type']=='choice':
            choices=[c['value'] for c in q['choices']];ps=a.get('probabilities')
            if a.get('choice') not in choices or not isinstance(ps,list) or len(ps)!=len(choices):raise InvalidDecision('choice')
            if any(not isinstance(p,dict) for p in ps):raise InvalidDecision('distribution_object')
            values=[p.get('value') for p in ps]
            if any(not isinstance(v,str) for v in values) or set(values)!=set(choices) or len(set(values))!=len(values):raise InvalidDecision('distribution_choices')
            if any(not number(p.get('probability')) or not 0<=p['probability']<=1 for p in ps):raise InvalidDecision('distribution_probability')
            if abs(sum(p['probability'] for p in ps)-1)>.02:raise InvalidDecision('distribution_sum')
            if not number(a.get('confidence')) or not 0<=a['confidence']<=1:raise InvalidDecision('confidence')
        else:raise InvalidDecision('unsupported_question_type')
    usage=body.get('usage')
    if usage is not None:
        if not isinstance(usage,dict):raise InvalidDecision('usage_object')
        for k in ['input_tokens','output_tokens','total_tokens']:
            if k in usage and (type(usage[k]) is not int or usage[k]<0):raise InvalidDecision('usage_count')
        details=usage.get('input_tokens_details',{})
        if not isinstance(details,dict):raise InvalidDecision('usage_details')
        for k in ['cached_tokens','cache_write_tokens']:
            if k in details and (type(details[k]) is not int or details[k]<0):raise InvalidDecision('usage_count')
        if 'input_tokens' in usage and sum(details.get(k,0) for k in ['cached_tokens','cache_write_tokens'])>usage['input_tokens']:raise InvalidDecision('usage_cache_total')
        if all(k in usage for k in ['input_tokens','output_tokens','total_tokens']) and usage['total_tokens']!=usage['input_tokens']+usage['output_tokens']:raise InvalidDecision('usage_total')
    return {a['name']:a for a in answers}


class Budget:
    def __init__(self,max_attempts,max_reserved_usd):
        self.max_attempts=max_attempts;self.max_reserved_usd=max_reserved_usd;self.attempts=0;self.reserved_usd=0;self.lock=threading.Lock();self.deadline=time.monotonic()+900
    def reserve(self,request):
        # Conservative one-byte-per-token planning allowance + fixed overhead.
        usd=(len(json.dumps(request).encode())+1024)*.125/1e6
        with self.lock:
            if time.monotonic()>=self.deadline or self.attempts>=self.max_attempts or self.reserved_usd+usd>self.max_reserved_usd:return False
            self.attempts+=1;self.reserved_usd+=usd;return True


def transport(request,key,budget,timeout=20,retries=1,opener=urllib.request.urlopen,sleep=time.sleep):
    attempts=[]
    for index in range(retries+1):
        if not budget.reserve(request):return {'ok':False,'attempts':attempts,'deferred':'attempt_or_spend_budget'}
        start=time.monotonic();attempt={};transient=False;delay=.25*(index+1)
        req=urllib.request.Request('https://api.openai.com/v1/decisions',data=json.dumps(request).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        try:
            with opener(req,timeout=timeout) as response:
                attempt['status']=response.status
                raw=response.read()
            try:body=json.loads(raw)
            except (ValueError,UnicodeDecodeError):raise InvalidDecision('invalid_json')
            # Preserve returned usage and refused/invalid typed bodies for synthetic diagnostics.
            attempt['body']=body
            if attempt['status']!=200:raise InvalidDecision('unexpected_success_status')
            validate(body,request)
            attempt['latency_ms']=round((time.monotonic()-start)*1000);attempts.append(attempt)
            return {'ok':True,'attempts':attempts}
        except urllib.error.HTTPError as error:
            attempt['status']=error.code
            value=error.headers.get('Retry-After','') if error.headers else ''
            retry_after=None
            if value.isdigit():retry_after=int(value)
            elif value:
                try:retry_after=max(0,math.ceil((parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds()))
                except (ValueError,TypeError,OverflowError):pass
            error.close();transient=error.code==429 or error.code>=500
            if error.code>=500:attempt['uncertain_charge']=True
            if retry_after is not None:
                if retry_after>5:
                    # Defer to a later run rather than retrying before the provider allows it.
                    attempt['retry_after_seconds']=retry_after;attempt['deferred_retry_after']=True;transient=False
                else:delay=max(delay,retry_after)
        except (TimeoutError,urllib.error.URLError):
            attempt['error']='timeout_or_network';attempt['uncertain_charge']=True;transient=True
        except InvalidDecision as error:
            attempt['error']=str(error)
            if not isinstance(attempt.get('body'),dict) or 'usage' not in attempt['body']:attempt['uncertain_charge']=True
        attempt['latency_ms']=round((time.monotonic()-start)*1000);attempts.append(attempt)
        if not transient or index==retries:break
        sleep(delay)
    return {'ok':False,'attempts':attempts}
