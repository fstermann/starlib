import re
from datetime import date
from typing import Any


def bold(text: str) -> str:
    return f"__{text}__" if text else text


def clean_artists(artists: str) -> str:
    artists = remove_double_spaces(artists)
    artists = remove_free_dl(artists)
    artists = remove_premiere(artists)
    return re.sub(r"\s+(&|and|x|X)\s+", ", ", artists)


def titelize(string: str) -> str:
    string = string.title()
    string = re.sub("dj", "DJ", string, flags=re.IGNORECASE)
    string = re.sub("'S", "'s", string)
    string = re.sub("'Re", "'re", string)
    return re.sub("'T", "'t", string)


def changed_string(old: Any, new: Any) -> str:
    return " ⚠️ " if old != new else ""


def remove_free_dl(title: str):
    return re.sub(r"[\(\[\{]\s*free\s*(dl|download)\s*.*?[\)\]\}]", "", title, flags=re.IGNORECASE).strip()


def remove_remix(title: str):
    return re.sub(r"\(.*edit|mix|bootleg|rework|flip.*\)", "", title, flags=re.IGNORECASE).strip()


def remove_original_mix(title: str):
    return re.sub(r"\(.*original mix.*\)", "", title, flags=re.IGNORECASE).strip()


def remove_mix(title: str) -> str:
    """Remove parenthesized mix/edit type strings from a title.

    Removes tokens like (Extended Mix), (Original Mix), (Radio Edit), (Club Mix), etc.
    """
    return re.sub(r"\([^)]*\b(?:edit|mix|bootleg|rework|flip)\b[^)]*\)", "", title, flags=re.IGNORECASE).strip()


def remove_premiere(title: str):
    return re.sub(r"(premiere|premear):?", "", title, flags=re.IGNORECASE).strip()


def remove_parenthesis(title: str):
    return re.sub(r"\[.*?\]", "", title).strip()


def remove_double_spaces(title: str):
    return re.sub(r"\s+", " ", title).strip()


def replace_underscores(title: str):
    return re.sub(r"_", " ", title).strip()


def is_remix(title: str) -> bool:
    return bool(re.search(r"\(.*edit|mix|bootleg|rework|flip.*\)", title, flags=re.IGNORECASE))


def get_mix_name(title: str) -> str | None:
    if match := re.search(r"\((.*)\)", title):
        return match.group(1).replace(get_mix_arist(title) or "", "").strip()
    return None


def get_first_artist(title: str) -> str | None:
    if match := re.match(r"(.*?)\s*-\s*(.*)", title):
        return match.group(1).strip()
    return None


def get_mix_arist(title: str) -> str | None:
    if match := re.search(r"\((.*)\)", title):
        mix_name = match.group(1)
        return re.sub(r"edit|remix|bootleg|rework|mix|flip", "", mix_name, flags=re.IGNORECASE).strip()
    return None


def get_raw_title(title: str) -> str:
    if match := re.match(r"(.*?)\s*-\s*([^(]*)\s*\(?", title):
        return match.group(2)
    return title


def clean_title(title: str):
    title = remove_double_spaces(title)
    title.replace("–", "-")  # noqa: RUF001
    title = remove_free_dl(title)
    title = remove_premiere(title)
    if is_remix(title):
        return title
    if match := re.match(r"(.*?)\s*-\s*(.*)", title):
        title = match.group(2)
    return title


def parse_date(text: str) -> date | None:
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None
