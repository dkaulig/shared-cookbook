namespace SharedCookbook.Api.Jobs;

/// <summary>
/// Typed error thrown by the extraction jobs when the Python service
/// returned a response the caller cannot recover from by retrying.
///
/// - <see cref="IsTerminal"/> <c>= true</c> → the Hangfire job must
///   not retry (Python 4xx: invalid URL, private video, bad schema).
/// - <see cref="IsTerminal"/> <c>= false</c> → the job is free to
///   retry (Python 5xx, network, timeout).
///
/// The two code paths diverge in how they transition the
/// <see cref="SharedCookbook.Domain.Entities.RecipeImport"/>: terminal
/// errors settle straight to <c>Error</c>, transient ones rethrow and
/// let Hangfire's <c>AutomaticRetry</c> pick it up.
/// </summary>
public sealed class PythonExtractorException : Exception
{
    public PythonExtractorException(string message, bool isTerminal, int? statusCode = null)
        : base(message)
    {
        IsTerminal = isTerminal;
        StatusCode = statusCode;
    }

    public PythonExtractorException(string message, bool isTerminal, int? statusCode, Exception inner)
        : base(message, inner)
    {
        IsTerminal = isTerminal;
        StatusCode = statusCode;
    }

    /// <summary>When true, Hangfire must treat this as a terminal failure and
    /// stop retrying.</summary>
    public bool IsTerminal { get; }

    /// <summary>The HTTP status code the Python service returned, when known.
    /// Null for transport-level failures.</summary>
    public int? StatusCode { get; }
}
