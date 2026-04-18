using System.Security.Cryptography;
using System.Text;
using FamilienKochbuch.Domain.Entities;
using Konscious.Security.Cryptography;
using Microsoft.AspNetCore.Identity;

namespace FamilienKochbuch.Infrastructure.Identity;

/// <summary>
/// Argon2id password hasher plugged into ASP.NET Identity via
/// <see cref="IPasswordHasher{TUser}"/>. Encoded hash format:
/// <c>$argon2id$v=19$m={memoryKib},t={timeCost},p={parallelism}$base64(salt)$base64(hash)</c>.
///
/// Parameters follow the PRD directive (S1 spec): time cost 3, memory cost
/// 64 MiB (65 536 KiB), parallelism 1. These are deliberately higher than
/// the OWASP minimum to stay comfortable as Argon2 attack hardware improves,
/// and remain well within the ~150 ms/verify budget acceptable for a login.
/// </summary>
public class Argon2idPasswordHasher : IPasswordHasher<User>
{
    private const int SaltLengthBytes = 16;
    private const int HashLengthBytes = 32;
    private const int MemorySizeKib = 64 * 1024; // 64 MiB
    private const int Iterations = 3;
    private const int DegreeOfParallelism = 1;
    private const int Version = 0x13; // 19 — Argon2 v1.3

    public string HashPassword(User user, string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        var salt = RandomNumberGenerator.GetBytes(SaltLengthBytes);
        var hash = ComputeHash(password, salt);

        return Encode(salt, hash);
    }

    public PasswordVerificationResult VerifyHashedPassword(
        User user, string hashedPassword, string providedPassword)
    {
        ArgumentNullException.ThrowIfNull(hashedPassword);
        ArgumentNullException.ThrowIfNull(providedPassword);

        if (!TryDecode(hashedPassword, out var salt, out var expected))
            return PasswordVerificationResult.Failed;

        var actual = ComputeHash(providedPassword, salt);

        return CryptographicOperations.FixedTimeEquals(actual, expected)
            ? PasswordVerificationResult.Success
            : PasswordVerificationResult.Failed;
    }

    private static byte[] ComputeHash(string password, byte[] salt)
    {
        using var argon2 = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            DegreeOfParallelism = DegreeOfParallelism,
            MemorySize = MemorySizeKib,
            Iterations = Iterations,
        };

        return argon2.GetBytes(HashLengthBytes);
    }

    private static string Encode(byte[] salt, byte[] hash)
    {
        return string.Create(null,
            stackalloc char[256],
            $"$argon2id$v={Version}$m={MemorySizeKib},t={Iterations},p={DegreeOfParallelism}$"
                + $"{Convert.ToBase64String(salt).TrimEnd('=')}$"
                + $"{Convert.ToBase64String(hash).TrimEnd('=')}");
    }

    /// <summary>
    /// Parses the encoded hash emitted by <see cref="Encode"/>. Returns false
    /// for any unrecognized format — callers map that to <see cref="PasswordVerificationResult.Failed"/>
    /// so a garbled stored hash just looks like a wrong password to the attacker.
    /// </summary>
    private static bool TryDecode(string encoded, out byte[] salt, out byte[] hash)
    {
        salt = [];
        hash = [];

        var parts = encoded.Split('$');
        // Expected: ["", "argon2id", "v=19", "m=...,t=...,p=...", saltB64, hashB64]
        if (parts.Length != 6 || parts[1] != "argon2id") return false;

        try
        {
            salt = Convert.FromBase64String(PadBase64(parts[4]));
            hash = Convert.FromBase64String(PadBase64(parts[5]));
        }
        catch (FormatException)
        {
            return false;
        }

        return salt.Length == SaltLengthBytes && hash.Length == HashLengthBytes;
    }

    private static string PadBase64(string value) =>
        (value.Length % 4) switch
        {
            2 => value + "==",
            3 => value + "=",
            _ => value,
        };
}
