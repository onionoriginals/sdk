"""Extract literal example text from fixed W3C Recommendations; compute no vectors."""

from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
import json
import re
from urllib.request import urlopen


class Examples(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.active = None
        self.in_pre = False
        self.examples = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div":
            if self.active:
                self.depth += 1
            elif "example" in attrs.get("class", "").split():
                self.active = {"anchor": attrs["id"], "heading": [], "literal": []}
                self.depth = 1
        if tag == "pre" and self.active:
            self.in_pre = True

    def handle_endtag(self, tag):
        if tag == "pre":
            self.in_pre = False
        if tag == "div" and self.active:
            self.depth -= 1
            if self.depth == 0:
                heading = "".join(self.active["heading"]).strip()
                number = int(re.search(r"Example\s*(\d+)", heading).group(1))
                self.examples[number] = {
                    "number": number,
                    "anchor": self.active["anchor"],
                    "heading": heading,
                    "literal": "".join(self.active["literal"]).strip(),
                }
                self.active = None

    def handle_data(self, data):
        if self.active:
            self.active["literal" if self.in_pre else "heading"].append(data)


def main():
    destination = Path(__file__).resolve().parent
    for specification, suites in [
        ("ecdsa", [("ecdsa-jcs-2019-p256", 49), ("ecdsa-jcs-2019-p384", 60)]),
        ("eddsa", [("eddsa-jcs-2022-ed25519", 29)]),
    ]:
        url = f"https://www.w3.org/TR/2025/REC-vc-di-{specification}-20250515/"
        with urlopen(url, timeout=30) as response:
            source = response.read()
        parser = Examples()
        parser.feed(source.decode("utf-8"))
        for name, first in suites:
            examples = [parser.examples[number] for number in range(first, first + 11)]
            for example in examples:
                example["sourceUrl"] = url + "#" + example.pop("anchor")
            result = {
                "status": "Published literal vectors; not Originals processor conformance evidence.",
                "source": url,
                "sourcePageSha256": sha256(source).hexdigest(),
                "attribution": "Copyright 2025 World Wide Web Consortium. W3C permissive document license.",
                "license": "https://www.w3.org/copyright/document-license-2023/",
                "extraction": "HTML character references decoded; whitespace outside each preformatted example trimmed. No canonical strings, digests, keys, or signatures generated.",
                "suite": name,
                "examples": examples,
            }
            (destination / f"{name}.json").write_text(
                json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            print(f"Extracted {name}: examples {first}-{first + 10}")


if __name__ == "__main__":
    main()
