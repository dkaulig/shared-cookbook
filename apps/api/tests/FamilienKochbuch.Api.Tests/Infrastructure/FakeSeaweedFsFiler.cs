using System.Collections.Concurrent;
using System.Net;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// In-memory stand-in for the SeaweedFS filer HTTP endpoint. The
/// <see cref="Handler"/> is a <see cref="DelegatingHandler"/> that can be
/// registered as the default <see cref="HttpMessageHandler"/> for the named
/// <see cref="IHttpClientFactory"/> client used by the photo proxy
/// endpoint, so tests run without any real SeaweedFS container.
/// </summary>
public class FakeSeaweedFsFiler
{
    public ConcurrentDictionary<string, (byte[] Content, string ContentType)> Objects { get; } = new();

    public FakeFilerHandler Handler { get; }

    public FakeSeaweedFsFiler()
    {
        Handler = new FakeFilerHandler(this);
    }

    public void Put(string path, byte[] content, string contentType)
    {
        Objects[NormalizePath(path)] = (content, contentType);
    }

    public void Remove(string path) => Objects.TryRemove(NormalizePath(path), out _);

    public void Clear() => Objects.Clear();

    internal static string NormalizePath(string path) => path.TrimStart('/');

    public class FakeFilerHandler : DelegatingHandler
    {
        private readonly FakeSeaweedFsFiler _state;

        public FakeFilerHandler(FakeSeaweedFsFiler state)
        {
            _state = state;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = NormalizePath(request.RequestUri!.AbsolutePath);

            if (request.Method == HttpMethod.Get)
            {
                if (_state.Objects.TryGetValue(path, out var entry))
                {
                    var response = new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new ByteArrayContent(entry.Content),
                    };
                    response.Content.Headers.ContentType =
                        new System.Net.Http.Headers.MediaTypeHeaderValue(entry.ContentType);
                    return Task.FromResult(response);
                }
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            }

            if (request.Method == HttpMethod.Put)
            {
                var content = request.Content is null
                    ? Array.Empty<byte>()
                    : request.Content.ReadAsByteArrayAsync(cancellationToken).GetAwaiter().GetResult();
                var contentType = request.Content?.Headers.ContentType?.MediaType
                                  ?? "application/octet-stream";
                _state.Objects[path] = (content, contentType);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created));
            }

            if (request.Method == HttpMethod.Delete)
            {
                _state.Objects.TryRemove(path, out _);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.MethodNotAllowed));
        }
    }
}
