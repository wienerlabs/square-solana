// Sözleşme IDL'lerinden (idls/ → repo kökündeki idl/) programlara özel event makroları üretir (BC-16).
//
// `square_<program>_events!()` çağıran crate'te sözleşmedeki event'leri `#[event]` struct'ları olarak
// tanımlar. Event'in programın IDL'ine girmesi için `#[event]`'in o programın crate'inde olması gerekir;
// makro bunu, alanları elle tekrar yazmadan sağlar. Alanlardaki tanımlı tipler (`AgentStatus`,
// `DisputeResolution` …) çağıranın kapsamından çözülür.
//
// Testler için her event'e örnek değer kuran ifadeler de üretilir: makronun struct'ı ile
// `declare_program!`'ın ürettiği sözleşme struct'ı aynı değerle aynı baytları vermelidir.
use std::{env, fmt::Write as _, fs, path::PathBuf};

use serde_json::Value;

const PROGRAMS: [(&str, &str); 4] = [
    ("registry", "square_registry_contract"),
    ("policy", "square_policy_contract"),
    ("verifier", "square_verifier_contract"),
    ("escrow", "square_escrow_contract"),
];

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    println!("cargo:rerun-if-changed=build.rs");

    let mut macros = String::new();
    let mut tests = String::new();
    for (key, idl_name) in PROGRAMS {
        let path = root.join("idls").join(format!("{idl_name}.json"));
        println!("cargo:rerun-if-changed={}", path.display());
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} okunamadı: {e}", path.display()));
        let idl: Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{} geçersiz: {e}", path.display()));
        let gen = Program::new(&idl);
        macros.push_str(&gen.macro_rules(key, idl_name));
        tests.push_str(&gen.tests(key, idl_name));
    }
    fs::write(out.join("events_macros.rs"), macros).expect("events_macros.rs yazılamadı");
    fs::write(out.join("events_tests.rs"), tests).expect("events_tests.rs yazılamadı");
}

struct Program<'a> {
    events: Vec<&'a str>,
    types: Vec<&'a Value>,
}

impl<'a> Program<'a> {
    fn new(idl: &'a Value) -> Self {
        let events = idl["events"]
            .as_array()
            .map(|events| events.iter().filter_map(|e| e["name"].as_str()).collect())
            .unwrap_or_default();
        let types = idl["types"]
            .as_array()
            .map(|t| t.iter().collect())
            .unwrap_or_default();
        Self { events, types }
    }

    fn type_def(&self, name: &str) -> &'a Value {
        self.types
            .iter()
            .copied()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("IDL'de tip yok: {name}"))
    }

    fn fields(&self, event: &str) -> &'a Vec<Value> {
        self.type_def(event)["type"]["fields"]
            .as_array()
            .unwrap_or_else(|| panic!("{event} struct değil"))
    }

    fn macro_rules(&self, key: &str, idl_name: &str) -> String {
        let mut s = String::new();
        writeln!(
            s,
            "/// `{idl_name}` IDL'indeki event'leri çağıran crate'te `#[event]` olarak tanımlar (BC-16)."
        )
        .unwrap();
        writeln!(
            s,
            "#[macro_export]\nmacro_rules! square_{key}_events {{\n    () => {{"
        )
        .unwrap();
        for event in &self.events {
            for doc in docs(self.type_def(event)) {
                writeln!(s, "        #[doc = {doc:?}]").unwrap();
            }
            writeln!(
                s,
                "        #[::anchor_lang::event]\n        pub struct {event} {{"
            )
            .unwrap();
            for field in self.fields(event) {
                for doc in docs(field) {
                    writeln!(s, "            #[doc = {doc:?}]").unwrap();
                }
                let name = field["name"].as_str().expect("alan adı");
                writeln!(s, "            pub {name}: {},", rust_type(&field["type"])).unwrap();
            }
            writeln!(s, "        }}").unwrap();
        }
        writeln!(s, "    }};\n}}\n").unwrap();
        s
    }

    fn tests(&self, key: &str, idl_name: &str) -> String {
        let mut defined = Vec::new();
        for event in &self.events {
            for field in self.fields(event) {
                collect_defined(&field["type"], &mut defined);
            }
        }
        let mut s = String::new();
        writeln!(
            s,
            "mod {key} {{\n    use anchor_lang::prelude::*;\n    use anchor_lang::Event;"
        )
        .unwrap();
        if !defined.is_empty() {
            writeln!(
                s,
                "    use crate::contract::{idl_name}::types::{{{}}};",
                defined.join(", ")
            )
            .unwrap();
        }
        writeln!(
            s,
            "    use crate::contract::{idl_name}::events as contract;"
        )
        .unwrap();
        writeln!(
            s,
            "    mod local {{\n        use super::*;\n        square_{key}_events!();\n    }}"
        )
        .unwrap();
        for event in &self.events {
            let value = self.struct_sample(event);
            writeln!(
                s,
                "    #[test]\n    #[allow(non_snake_case)]\n    fn {event}() {{\n        let local = local::{event} {value};\n        let contract = contract::{event} {value};\n        assert_eq!(local.data(), contract.data());\n        assert_eq!(<local::{event} as anchor_lang::Discriminator>::DISCRIMINATOR, <contract::{event} as anchor_lang::Discriminator>::DISCRIMINATOR);\n    }}"
            )
            .unwrap();
        }
        writeln!(s, "}}\n").unwrap();
        s
    }

    /// `{ alan: değer, … }` biçiminde örnek alanlar; her alana farklı bir değer verilir.
    fn struct_sample(&self, name: &str) -> String {
        let fields = self.type_def(name)["type"]["fields"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let parts: Vec<String> = fields
            .iter()
            .enumerate()
            .map(|(i, f)| {
                format!(
                    "{}: {}",
                    f["name"].as_str().unwrap(),
                    self.sample(&f["type"], i as u8 + 1)
                )
            })
            .collect();
        format!("{{ {} }}", parts.join(", "))
    }

    fn sample(&self, ty: &Value, n: u8) -> String {
        if let Some(prim) = ty.as_str() {
            return match prim {
                "bool" => "true".into(),
                "pubkey" => format!("Pubkey::new_from_array([{n}; 32])"),
                "string" => format!("String::from(\"s{n}\")"),
                "bytes" => format!("vec![{n}u8]"),
                "i8" | "i16" | "i32" | "i64" | "i128" => format!("-{n}"),
                _ => format!("{n}"),
            };
        }
        if let Some(arr) = ty.get("array") {
            let len = arr[1].as_u64().expect("dizi uzunluğu");
            return format!("[{}; {len}]", self.sample(&arr[0], n));
        }
        if let Some(inner) = ty.get("vec") {
            return format!("vec![{}]", self.sample(inner, n));
        }
        if let Some(inner) = ty.get("option") {
            return format!("Some({})", self.sample(inner, n));
        }
        if let Some(defined) = ty.get("defined") {
            let name = defined["name"].as_str().expect("tanımlı tip adı");
            let def = &self.type_def(name)["type"];
            return match def["kind"].as_str() {
                Some("struct") => format!("{name} {}", self.struct_sample(name)),
                Some("enum") => {
                    // Alan taşıyan bir varyant varsa onu seç: düzenin de karşılaştırılması için.
                    let variants = def["variants"].as_array().expect("varyantlar");
                    let variant = variants
                        .iter()
                        .find(|v| v.get("fields").is_some())
                        .unwrap_or(&variants[0]);
                    let vname = variant["name"].as_str().unwrap();
                    match variant.get("fields").and_then(|f| f.as_array()) {
                        Some(fields) if fields.first().and_then(|f| f.get("name")).is_some() => {
                            let parts: Vec<String> = fields
                                .iter()
                                .map(|f| {
                                    format!(
                                        "{}: {}",
                                        f["name"].as_str().unwrap(),
                                        self.sample(&f["type"], n)
                                    )
                                })
                                .collect();
                            format!("{name}::{vname} {{ {} }}", parts.join(", "))
                        }
                        Some(fields) => {
                            let parts: Vec<String> =
                                fields.iter().map(|t| self.sample(t, n)).collect();
                            format!("{name}::{vname}({})", parts.join(", "))
                        }
                        None => format!("{name}::{vname}"),
                    }
                }
                other => panic!("desteklenmeyen tip türü {other:?}: {name}"),
            };
        }
        panic!("desteklenmeyen IDL tipi: {ty}");
    }
}

fn docs(v: &Value) -> Vec<String> {
    v["docs"]
        .as_array()
        .map(|d| {
            d.iter()
                .filter_map(|x| x.as_str().map(|s| format!(" {s}")))
                .collect()
        })
        .unwrap_or_default()
}

fn rust_type(ty: &Value) -> String {
    if let Some(prim) = ty.as_str() {
        return match prim {
            "pubkey" => "Pubkey".into(),
            "string" => "String".into(),
            "bytes" => "Vec<u8>".into(),
            other => other.into(),
        };
    }
    if let Some(arr) = ty.get("array") {
        return format!(
            "[{}; {}]",
            rust_type(&arr[0]),
            arr[1].as_u64().expect("dizi uzunluğu")
        );
    }
    if let Some(inner) = ty.get("vec") {
        return format!("Vec<{}>", rust_type(inner));
    }
    if let Some(inner) = ty.get("option") {
        return format!("Option<{}>", rust_type(inner));
    }
    if let Some(defined) = ty.get("defined") {
        return defined["name"].as_str().expect("tanımlı tip adı").into();
    }
    panic!("desteklenmeyen IDL tipi: {ty}");
}

fn collect_defined(ty: &Value, out: &mut Vec<String>) {
    if let Some(defined) = ty.get("defined") {
        let name = defined["name"]
            .as_str()
            .expect("tanımlı tip adı")
            .to_string();
        if !out.contains(&name) {
            out.push(name);
        }
    }
    for key in ["vec", "option"] {
        if let Some(inner) = ty.get(key) {
            collect_defined(inner, out);
        }
    }
    if let Some(arr) = ty.get("array") {
        collect_defined(&arr[0], out);
    }
}
