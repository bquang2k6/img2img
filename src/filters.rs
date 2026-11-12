use serde::Deserialize;

#[derive(Deserialize)]
struct FilterCategory {
    #[serde(default)]
    filters: Vec<FilterItem>,
}

#[derive(Deserialize)]
struct FilterItem {
    prompt: Option<String>,
    filter_id: Option<String>,
}

pub fn normalize(s: &str) -> String {
    s.replace("\\n", " ")
        .replace('\n', " ")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

pub async fn detect_filter_id(prompt: &str) -> Result<Option<String>, String> {
    let raw = tokio::fs::read_to_string("filters.json")
        .await
        .map_err(|e| e.to_string())?;
    let categories: Vec<FilterCategory> =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let normalized_prompt = normalize(prompt);
    for category in categories {
        for filter in category.filters {
            if let (Some(fp), Some(fid)) = (filter.prompt, filter.filter_id)
                && !fp.is_empty()
                && normalized_prompt.contains(&normalize(&fp))
            {
                return Ok(Some(fid));
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_matches_js_behavior() {
        let a = normalize("Hello,\\nWorld! 123\nTest_ok");
        let b = normalize("Hello, World! 123 Test_ok");
        assert_eq!(a, "helloworld123testok");
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn detect_filter_id_finds_known_filter() {
        let prompt = "Preserve the original photo and background. Add lush, deep green vines and subtle flowers throughout the environment, with some vines reaching toward and around the user to create a magical, interactive feeling. Add 1–2 soft roses in the background, mixing white and pink. Include small and subtle glowing fireflies for warmth and atmosphere, but keep them small, dim, sparse, and understated. Keep the overall look dreamy, natural, and slightly enchanted, without turning the setting into a full greenhouse.";
        let detected = detect_filter_id(prompt).await.unwrap();
        assert_eq!(detected.as_deref(), Some("practical_magic_2"));
    }
}


