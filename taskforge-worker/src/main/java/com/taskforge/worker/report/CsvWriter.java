package com.taskforge.worker.report;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Minimal CSV output: UTF-8, {@code \r\n} line ends, RFC 4180 quoting, and numbers formatted with
 * {@link Locale#ROOT} so the decimal separator is always a point whatever the JVM's default locale.
 */
final class CsvWriter {

    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private final PrintWriter out = new PrintWriter(bytes, false, StandardCharsets.UTF_8);

    CsvWriter row(Object... cells) {
        StringBuilder line = new StringBuilder();
        for (int i = 0; i < cells.length; i++) {
            if (i > 0) line.append(',');
            line.append(cell(cells[i]));
        }
        out.print(line);
        out.print("\r\n");
        return this;
    }

    /** A comment-style line such as a summary; written verbatim after a blank line. */
    CsvWriter note(String text) {
        out.print("\r\n");
        out.print(text);
        out.print("\r\n");
        return this;
    }

    byte[] toBytes() {
        out.flush();
        return bytes.toByteArray();
    }

    static String money(double value) {
        return String.format(Locale.ROOT, "%.2f", value);
    }

    private static String cell(Object value) {
        if (value == null) return "";
        String s = value instanceof Double d ? money(d) : String.valueOf(value);
        if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
            return '"' + s.replace("\"", "\"\"") + '"';
        }
        return s;
    }
}
