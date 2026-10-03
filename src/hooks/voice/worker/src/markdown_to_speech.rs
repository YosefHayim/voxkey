//! Markdown → spoken prose: one sentence per line, code read symbol by symbol.

use regex::Regex;

fn sentence(text: &str) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() || clean.ends_with(['.', '!', '?', ':', ';']) {
        clean
    } else {
        format!("{clean}.")
    }
}

fn inline_speech(text: &str) -> String {
    let mut clean = text.to_string();
    let image = Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").unwrap();
    clean = image
        .replace_all(&clean, |caps: &regex::Captures| {
            let alt = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
            let alt = if alt.is_empty() { "image" } else { alt };
            let source = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();
            format!("Image: {alt}. Source {source}")
        })
        .into_owned();
    let link = Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap();
    clean = link
        .replace_all(&clean, |caps: &regex::Captures| {
            let label = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
            let address = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();
            format!("{label}, link {address}")
        })
        .into_owned();
    let auto = Regex::new(r"<(https?://[^>]+)>").unwrap();
    clean = auto
        .replace_all(&clean, |caps: &regex::Captures| format!("link {}", caps.get(1).map(|m| m.as_str()).unwrap_or("")))
        .into_owned();
    let code = Regex::new(r"`([^`]*)`").unwrap();
    clean = code.replace_all(&clean, "$1").into_owned();
    let tags = Regex::new(r"<[^>]+>").unwrap();
    clean = tags.replace_all(&clean, " ").into_owned();
    // Strip unescaped emphasis markers (the regex crate has no look-behind).
    let chars: Vec<char> = clean.chars().collect();
    let stripped: String = chars
        .iter()
        .enumerate()
        .filter(|(index, ch)| !(matches!(ch, '*' | '_' | '~') && (*index == 0 || chars[index - 1] != '\\')))
        .map(|(_, ch)| *ch)
        .collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn code_speech(text: &str) -> String {
    let mut clean = text.trim().to_string();
    let replacements = [
        ("===", " strictly equals "),
        ("!==", " does not strictly equal "),
        ("=>", " arrow "),
        ("==", " equals "),
        ("!=", " does not equal "),
        (">=", " greater than or equal to "),
        ("<=", " less than or equal to "),
        ("&&", " and "),
        ("||", " or "),
        ("=", " equals "),
        (";", " semicolon "),
        ("{", " open brace "),
        ("}", " close brace "),
        ("[", " open bracket "),
        ("]", " close bracket "),
    ];
    for (symbol, spoken) in replacements {
        clean = clean.replace(symbol, spoken);
    }
    sentence(&clean)
}

fn language_name(token: &str) -> String {
    match token.to_ascii_lowercase().as_str() {
        "bash" => "Bash".into(),
        "css" => "CSS".into(),
        "html" => "HTML".into(),
        "js" | "javascript" => "JavaScript".into(),
        "json" => "JSON".into(),
        "jsx" => "JSX".into(),
        "md" | "markdown" => "Markdown".into(),
        "py" | "python" => "Python".into(),
        "sh" => "Shell".into(),
        "sql" => "SQL".into(),
        "ts" | "typescript" => "TypeScript".into(),
        "tsx" => "TSX".into(),
        "yaml" | "yml" => "YAML".into(),
        "" => "code".into(),
        other => other.to_string(),
    }
}

/// Render Markdown into a speech document (newline-separated sentences).
pub fn markdown_to_speech(markdown: &str) -> String {
    let fence = Regex::new(r"^\s*```\s*([^\s`]*)").unwrap();
    let heading = Regex::new(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$").unwrap();
    let unordered = Regex::new(r"^\s*[-+*]\s+(.+)$").unwrap();
    let ordered = Regex::new(r"^\s*([0-9]+)[.)]\s+(.+)$").unwrap();
    let quote = Regex::new(r"^\s*>\s?(.*)$").unwrap();
    let hr = Regex::new(r"^\s*(?:[-*_]\s*){3,}$").unwrap();
    let group = |caps: &regex::Captures, index: usize| caps.get(index).map_or("", |m| m.as_str()).to_string();

    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut spoken: Vec<String> = Vec::new();
    let mut in_code = false;
    for line in normalized.lines() {
        let blank = line.trim().is_empty();
        if let Some(caps) = fence.captures(line) {
            spoken.push(if in_code {
                "End code block.".into()
            } else {
                sentence(&format!("Code block, {}", language_name(&group(&caps, 1))))
            });
            in_code = !in_code;
        } else if in_code {
            spoken.push(if blank { "Blank line.".into() } else { code_speech(line) });
        } else if blank || hr.is_match(line) {
            continue;
        } else if let Some(caps) = heading.captures(line).or_else(|| unordered.captures(line)) {
            spoken.push(sentence(&inline_speech(&group(&caps, 1))));
        } else if let Some(caps) = ordered.captures(line) {
            spoken.push(sentence(&format!("{}. {}", group(&caps, 1), inline_speech(&group(&caps, 2)))));
        } else if let Some(caps) = quote.captures(line) {
            spoken.push(sentence(&format!("Quote. {}", inline_speech(&group(&caps, 1)))));
        } else {
            let clean = sentence(&inline_speech(line));
            if !clean.is_empty() {
                spoken.push(clean);
            }
        }
    }
    if in_code {
        spoken.push("End code block.".into());
    }
    spoken.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_heading_and_paragraph() {
        let out = markdown_to_speech("# Hello\n\nWorld **bold**");
        assert!(out.contains("Hello."));
        assert!(out.contains("World bold."));
    }

    #[test]
    fn renders_code_fence() {
        let out = markdown_to_speech("```ts\nconst x = 1;\n```");
        assert!(out.contains("Code block, TypeScript."));
        assert!(out.contains("End code block."));
    }
}
