//! Spoken formatting for dictation: "comma", "new line", "bullet", "literal …", and replacements.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
enum Command {
    Punctuation(&'static str),
    NewLine,
    NewParagraph,
    Bullet,
    NumberedList,
    NextItem,
}

const DICTATION_COMMANDS: &[(&[&str], Command)] = &[
    (&["exclamation", "mark"], Command::Punctuation("!")),
    (&["exclamation", "point"], Command::Punctuation("!")),
    (&["next", "bullet", "point"], Command::Bullet),
    (&["new", "bullet", "point"], Command::Bullet),
    (&["numbered", "list"], Command::NumberedList),
    (&["new", "paragraph"], Command::NewParagraph),
    (&["question", "mark"], Command::Punctuation("?")),
    (&["bullet", "list"], Command::Bullet),
    (&["bullet", "point"], Command::Bullet),
    (&["next", "bullet"], Command::Bullet),
    (&["new", "bullet"], Command::Bullet),
    (&["next", "item"], Command::NextItem),
    (&["next", "line"], Command::NewLine),
    (&["full", "stop"], Command::Punctuation(".")),
    (&["new", "line"], Command::NewLine),
    (&["semicolon"], Command::Punctuation(";")),
    (&["newline"], Command::NewLine),
    (&["period"], Command::Punctuation(".")),
    (&["comma"], Command::Punctuation(",")),
    (&["colon"], Command::Punctuation(":")),
    (&["bullet"], Command::Bullet),
    (&["dot"], Command::Punctuation(".")),
];

/// Format one utterance for the caret. Ends with a space when the next utterance should
/// start a new word; empty when nothing should be typed.
pub fn format_dictation(transcript: &str, replacements: &HashMap<String, String>) -> String {
    let words: Vec<&str> = transcript.split_whitespace().collect();
    let canonical: Vec<String> = words.iter().map(|word| canonical_word(word)).collect();
    let replacements = replacement_phrases(replacements);
    let mut out = Formatter::default();
    let mut index = 0;
    while index < words.len() {
        if canonical[index] == "literal" && index + 1 < words.len() {
            // "literal" types the next command or replacement phrase (or one word) as plain words.
            let len = command_at(&canonical, index + 1)
                .map(|(len, _)| len)
                .or_else(|| replacement_at(&canonical, index + 1, &replacements).map(|(len, _)| len))
                .unwrap_or(1);
            out.push_text(&words[index + 1..index + 1 + len].join(" "));
            index += 1 + len;
        } else if let Some((len, command)) = command_at(&canonical, index) {
            out.push_command(command);
            index += len;
        } else if let Some((len, written)) = replacement_at(&canonical, index, &replacements) {
            out.push_text(written);
            index += len;
        } else {
            out.push_text(words[index]);
            index += 1;
        }
    }
    if !out.text.is_empty() && out.needs_space {
        out.text.push(' ');
    }
    out.text
}

fn canonical_word(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// Replacement phrases in canonical words, longest first so the longest match wins.
fn replacement_phrases(replacements: &HashMap<String, String>) -> Vec<(Vec<String>, String)> {
    let mut phrases: Vec<(Vec<String>, String)> = replacements
        .iter()
        .map(|(heard, written)| {
            let phrase: Vec<String> = heard.split_whitespace().map(canonical_word).filter(|w| !w.is_empty()).collect();
            (phrase, written.trim().to_string())
        })
        .filter(|(phrase, written)| !phrase.is_empty() && !written.is_empty())
        .collect();
    phrases.sort_by_key(|(phrase, _)| std::cmp::Reverse(phrase.len()));
    phrases
}

fn matches_at<S: AsRef<str>>(words: &[String], index: usize, phrase: &[S]) -> bool {
    words.len() >= index + phrase.len() && phrase.iter().zip(&words[index..]).all(|(p, w)| p.as_ref() == w)
}

fn command_at(words: &[String], index: usize) -> Option<(usize, Command)> {
    DICTATION_COMMANDS
        .iter()
        .find(|(phrase, _)| matches_at(words, index, phrase))
        .map(|(phrase, command)| (phrase.len(), *command))
}

fn replacement_at<'a>(
    words: &[String],
    index: usize,
    replacements: &'a [(Vec<String>, String)],
) -> Option<(usize, &'a str)> {
    replacements
        .iter()
        .find(|(phrase, _)| matches_at(words, index, phrase))
        .map(|(phrase, written)| (phrase.len(), written.as_str()))
}

fn capitalize_first_letter(text: &str) -> String {
    match text.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        Some((i, c)) => format!("{}{}{}", &text[..i], c.to_ascii_uppercase(), &text[i + 1..]),
        None => text.to_string(),
    }
}

struct Formatter {
    text: String,
    at_line_start: bool,
    capitalize_next: bool,
    needs_space: bool,
    numbered_next: i32,
}

impl Default for Formatter {
    fn default() -> Self {
        Self { text: String::new(), at_line_start: true, capitalize_next: true, needs_space: false, numbered_next: 0 }
    }
}

impl Formatter {
    fn push_text(&mut self, text: &str) {
        let rendered = if self.capitalize_next { capitalize_first_letter(text) } else { text.to_string() };
        if self.needs_space {
            self.text.push(' ');
        }
        self.text.push_str(&rendered);
        self.at_line_start = false;
        // A sentence end (ignoring closing quotes) capitalizes the next word.
        self.capitalize_next =
            rendered.chars().rev().find(|c| !matches!(c, '"' | '\'')).is_some_and(|c| matches!(c, '.' | '!' | '?'));
        self.needs_space = true;
    }

    fn push_command(&mut self, command: Command) {
        match command {
            Command::Punctuation(mark) => {
                self.text.push_str(mark);
                self.at_line_start = false;
                self.capitalize_next = matches!(mark, "." | "!" | "?");
                self.needs_space = true;
            }
            Command::NewLine | Command::NewParagraph => {
                self.text.push_str(if matches!(command, Command::NewParagraph) { "\n\n" } else { "\n" });
                self.at_line_start = true;
                self.capitalize_next = true;
                self.needs_space = false;
            }
            Command::Bullet | Command::NumberedList | Command::NextItem => {
                if !self.at_line_start {
                    self.text.push('\n');
                }
                if matches!(command, Command::Bullet) {
                    self.text.push_str("- ");
                    self.numbered_next = 0;
                } else {
                    let number = if matches!(command, Command::NumberedList) || self.numbered_next < 1 {
                        1
                    } else {
                        self.numbered_next
                    };
                    self.text.push_str(&format!("{number}. "));
                    self.numbered_next = number + 1;
                }
                self.at_line_start = false;
                self.capitalize_next = true;
                self.needs_space = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_spoken_commands() {
        let replacements = HashMap::from([("Joseph".to_string(), "Yosef".to_string())]);
        let cases = [
            ("Hello comma my name is Joseph period", "Hello, my name is Yosef. "),
            (
                "I need three changes period new line bullet fix authentication next bullet add tests next bullet update documentation",
                "I need three changes.\n- Fix authentication\n- Add tests\n- Update documentation ",
            ),
            ("numbered list fix login next item add tests next item deploy", "1. Fix login\n2. Add tests\n3. Deploy "),
            ("use literal comma as the field name", "Use comma as the field name "),
            ("first new paragraph second", "First\n\nSecond "),
            ("", ""),
        ];
        for (spoken, typed) in cases {
            assert_eq!(format_dictation(spoken, &replacements), typed, "{spoken}");
        }
    }
}
