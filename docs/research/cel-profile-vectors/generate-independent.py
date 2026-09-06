import base64, hashlib, json, subprocess
from pathlib import Path
out=Path(__file__).resolve().parent
# Expected canonical strings below are literals, not SDK-generated snapshots.
cases=[
 ('rfc8785-number-format', '[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001]', '[333333333.3333333,1e+30,4.5,0.002,1e-27]', 'RFC 8785 section 3.2.2; array extracted from its published example'),
 ('numeric-and-json-property-names', '{"name":"é","2":"two","constructor":"literal","__proto__":{"kept":true},"10":"ten"}', '{"10":"ten","2":"two","__proto__":{"kept":true},"constructor":"literal","name":"é"}', 'Locally authored literal using RFC 8785 recursive UTF-16 property ordering; every own JSON field is retained'),
 ('nested-objects-and-array-order', '{"z":[{"b":2,"a":1},3,2,1],"a":{"y":true,"x":null}}', '{"a":{"x":null,"y":true},"z":[{"a":1,"b":2},3,2,1]}', 'Locally authored literal using RFC 8785 section 3.2.3'),
 ('unicode-utf16-key-order', '{"\\ufb33":7,"😀":6,"€":5,"ö":4,"\\u0080":3,"1":2,"\\r":1}', '{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}', 'RFC 8785 section 3.2.3 published key-order example, with locally substituted numeric values'),
 ('unicode-not-normalized-composed', '{"name":"é"}', '{"name":"é"}', 'RFC 8785 section 3.1 forbids Unicode normalization'),
 ('unicode-not-normalized-decomposed', '{"name":"é"}', '{"name":"é"}', 'RFC 8785 section 3.1 forbids Unicode normalization'),
 ('negative-zero', '[-0,0]', '[0,0]', 'RFC 8785 Appendix B negative-zero serialization'),
]
fixtures=[]
for name,source,canonical,basis in cases:
 json.loads(source)
 json.loads(canonical)
 data=canonical.encode('utf8')
 expected=hashlib.sha256(data).digest()
 openssl=subprocess.run(['openssl','dgst','-sha256','-binary'],input=data,capture_output=True,check=True).stdout
 assert expected==openssl
 fixtures.append({'name':name,'inputJson':source,'expectedCanonical':canonical,'expectedUtf8Hex':data.hex(),'expectedSha256Hex':expected.hex(),'expectedDigestMultibase':'u'+base64.urlsafe_b64encode(bytes([0x12,0x20])+expected).decode().rstrip('='),'basis':basis})
rejects=[
 {'name':'duplicate-object-members','inputJson':'{"name":"first","name":"second"}','expected':'reject before ordinary JSON parsing discards the duplicate'},
 {'name':'lone-surrogate-value','inputJson':'{"name":"\\ud800"}','expected':'reject invalid Unicode scalar sequence'},
 {'name':'lone-surrogate-key','inputJson':'{"\\udfff":1}','expected':'reject invalid Unicode scalar sequence'},
 {'name':'nonfinite-number','inputJson':'{"amount":1e999}','expected':'reject IEEE 754 infinity rather than serialize null'},
]
result={'status':'Canonicalization evidence only. Not an accepted Originals profile or a production verifier.','source':'https://www.rfc-editor.org/rfc/rfc8785.html','method':'Literal canonical strings; UTF-8 bytes hashed independently using Python hashlib and OpenSSL CLI. No Originals SDK implementation is imported. Expected did:cel/proof vectors await the wire/profile decision.','acceptedCanonicalization':fixtures,'rejectedCanonicalization':rejects}
(out/'canonical-json.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
print('Saved 7 canonical byte/hash vectors and 4 rejection cases; hashlib/OpenSSL digests agree.')
