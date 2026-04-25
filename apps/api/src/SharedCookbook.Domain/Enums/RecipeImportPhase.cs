namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Phase-bewusster Fortschritt für einen <see cref="Entities.RecipeImport"/>.
/// Der <see cref="Entities.ImportStatus"/>-Statemachine beschreibt die grobe
/// Lebenszeit des Imports (Queued → Running → Done/Error); die Phase beschreibt
/// <em>innerhalb</em> Running, welche Teilphase die Python-Extraktion gerade
/// durchläuft. Beide Werte landen auf der Wire (<c>GET /api/imports/{id}</c>
/// + SignalR-Event <c>RecipeImportProgressChanged</c>) und werden vom
/// Frontend für den phasen-spezifischen Fortschrittsbalken verwendet.
///
/// Die explizit vergebenen Int-Werte sind Teil des Wire-/On-Disk-Vertrags
/// — neue Phasen kommen am Ende dazu, bestehende Werte dürfen sich nie
/// verschieben. Monoton-steigende Werte ermöglichen den Out-Of-Order-Guard
/// in <see cref="Entities.RecipeImport.UpdateProgress"/>.
/// </summary>
public enum RecipeImportPhase
{
    /// <summary>Import ist in der Warteschlange — noch kein Python-Call.</summary>
    Queued = 0,

    /// <summary>yt-dlp lädt das Video herunter. URL-Pfad only.</summary>
    Downloading = 1,

    /// <summary>faster-whisper transkribiert das Audio. URL-Pfad only.</summary>
    Transcribing = 2,

    /// <summary>Azure OpenAI strukturiert den Transkript-Text in Rezept-JSON.</summary>
    Structuring = 3,

    /// <summary>Nachverarbeitung auf der .NET-Seite (Persistenz, Thumbnails).</summary>
    PostProcessing = 4,

    /// <summary>Azure Vision analysiert Foto(s). Photo-Pfad only; single-shot.</summary>
    VisionAnalysis = 5,

    /// <summary>Import abgeschlossen; Rezept gespeichert.</summary>
    Done = 6,

    /// <summary>Terminaler Fehlerzustand; <c>ErrorMessage</c> trägt den Grund.</summary>
    Error = 7,
}
