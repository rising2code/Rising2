"""Tiny SOAP helpers: parse a request envelope, build a response that looks
like what the old ZSI mock produced (the game is known to accept that)."""
from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


class Node:
    """Namespace-free view of an XML element."""

    def __init__(self, el: ET.Element) -> None:
        self.el = el
        self.name = local(el.tag)

    @property
    def text(self) -> str:
        return (self.el.text or "").strip()

    def children(self) -> list["Node"]:
        return [Node(c) for c in self.el]

    def child(self, name: str) -> "Node | None":
        for c in self.el:
            if local(c.tag).lower() == name.lower():
                return Node(c)
        return None

    def get(self, name: str, default: str = "") -> str:
        c = self.child(name)
        return c.text if c is not None else default

    def get_int(self, name: str, default: int = 0) -> int:
        try:
            return int(self.get(name, str(default)))
        except ValueError:
            return default

    def to_dict(self) -> dict:
        kids = self.children()
        if not kids:
            return self.text  # type: ignore[return-value]
        d: dict = {}
        for k in kids:
            v = k.to_dict()
            if k.name in d:
                if not isinstance(d[k.name], list):
                    d[k.name] = [d[k.name]]
                d[k.name].append(v)
            else:
                d[k.name] = v
        return d


def parse_envelope(body: bytes) -> Node:
    """Returns the operation element (first child of soap Body)."""
    root = ET.fromstring(body)
    for el in root.iter():
        if local(el.tag) == "Body":
            for op in el:
                return Node(op)
    raise ValueError("no SOAP Body/operation element found")


# --------------------------------------------------------------------------
# response building:  E("name", children...) / E("name", "text")
# --------------------------------------------------------------------------

class E:
    def __init__(self, name: str, *content) -> None:
        self.name = name
        self.content = content

    def render(self, prefix: str = "ns1") -> str:
        tag = f"{prefix}:{self.name}"
        if not self.content or (len(self.content) == 1 and self.content[0] is None):
            return f"<{tag}/>"
        inner = []
        for c in self.content:
            if isinstance(c, E):
                inner.append(c.render(prefix))
            elif isinstance(c, (list, tuple)):
                inner.extend(x.render(prefix) for x in c)
            elif c is not None:
                inner.append(escape(str(c)))
        return f"<{tag}>{''.join(inner)}</{tag}>"


def envelope(namespace: str, body: E) -> bytes:
    return (
        '<?xml version="1.0" ?>\n'
        '<SOAP-ENV:Envelope xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" '
        'xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" '
        'xmlns:ZSI="http://www.zolera.com/schemas/ZSI/" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<SOAP-ENV:Header/>"
        f'<SOAP-ENV:Body xmlns:ns1="{namespace}">'
        f"{body.render()}"
        "</SOAP-ENV:Body></SOAP-ENV:Envelope>"
    ).encode("utf-8")


def fault(message: str) -> bytes:
    return (
        '<?xml version="1.0" ?>\n'
        '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>'
        f"<SOAP-ENV:Fault><faultcode>SOAP-ENV:Server</faultcode><faultstring>{escape(message)}</faultstring>"
        "</SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>"
    ).encode("utf-8")
