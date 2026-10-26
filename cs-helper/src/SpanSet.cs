using Microsoft.CodeAnalysis.Text;

namespace Farol.CsHelper;

/// <summary>Sorted, non-overlapping spans with a logarithmic containment test (types with hundreds of members).</summary>
public sealed class SpanSet
{
    readonly TextSpan[] spans;

    public SpanSet(IEnumerable<TextSpan> spans)
    {
        var merged = new List<TextSpan>();
        foreach (var s in spans.OrderBy(s => s.Start).ThenByDescending(s => s.Length))
        {
            if (merged.Count > 0 && merged[^1].End >= s.End) continue;
            if (merged.Count > 0 && merged[^1].End > s.Start) merged[^1] = TextSpan.FromBounds(merged[^1].Start, s.End);
            else merged.Add(s);
        }
        this.spans = [.. merged];
    }

    public bool IsEmpty => spans.Length == 0;

    /// <summary>Whether a span starts inside one of the set's spans.</summary>
    public bool Covers(TextSpan s)
    {
        int lo = 0, hi = spans.Length - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) / 2;
            if (spans[mid].Start <= s.Start) lo = mid + 1;
            else hi = mid - 1;
        }
        return hi >= 0 && s.Start < spans[hi].End;
    }
}
