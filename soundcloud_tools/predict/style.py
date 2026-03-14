import logging
from functools import lru_cache

import numpy as np
from essentia.standard import (
    MonoLoader,
    TensorflowPredict2D,
    TensorflowPredictEffnetDiscogs,
    TensorflowPredictMusiCNN,
)

from soundcloud_tools.predict._discogs_genres import DISCOGS_GENRES
from soundcloud_tools.predict.base import Predictor

logger = logging.getLogger(__name__)


@lru_cache
def load_embedding_model():
    return TensorflowPredictEffnetDiscogs(
        graphFilename="discogs-effnet-bs64-1.pb",
        output="PartitionedCall:1",
    )


@lru_cache
def load_model():
    return TensorflowPredict2D(
        graphFilename="genre_discogs400-discogs-effnet-1.pb",
        input="serving_default_model_Placeholder",
        output="PartitionedCall:0",
    )


def get_classes_from_predictions(predictions) -> list[tuple[str, float]]:
    averaged = np.mean(predictions, axis=0)
    out = list(zip(DISCOGS_GENRES, averaged, strict=False))
    out.sort(key=lambda x: x[1], reverse=True)
    return out


def clean_electronic_classes(classes: list[tuple[str, float]]) -> list[tuple[str, float]]:
    return [(c.removeprefix("Electronic---"), prob) for c, prob in classes]


def predict(filename: str, embedding_model: TensorflowPredictMusiCNN, model: TensorflowPredict2D) -> np.ndarray:
    audio = MonoLoader(filename=filename, sampleRate=16000, resampleQuality=4)()
    logging.info(f"Audio shape {audio.shape}")
    embeddings = embedding_model(audio)
    logging.info(f"Embeddings Shape {embeddings.shape}")
    predictions = model(embeddings)
    return predictions


class StylePredictor(Predictor):
    title: str = "Style"
    help: str = "Predict the style/genre of the loaded track."

    def __init__(self, max_classes: int = 3):
        self.embedding_model = load_embedding_model()
        self.model = load_model()
        self.max_classes = max_classes

    def predict(self, filename: str) -> list[tuple[str, float]]:
        predictions = predict(filename, self.embedding_model, self.model)
        classes = get_classes_from_predictions(predictions)[: self.max_classes]
        return clean_electronic_classes(classes)
