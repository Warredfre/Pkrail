/* PK Rail engine — same algorithm as RailwayKit (Swift). No network required. */
(function (global) {
  "use strict";

  const EARTH = 6371000;

  function radians(d) { return d * Math.PI / 180; }
  function degrees(r) { return r * 180 / Math.PI; }

  function haversine(a, b) {
    const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
    const dLat = lat2 - lat1;
    const dLon = radians(b.longitude - a.longitude);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function metersPerDegree(latitude) {
    const lat = radians(latitude);
    const mLat = 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat);
    const mLon = 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat);
    return { lat: mLat, lon: Math.max(mLon, 1e-6) };
  }

  function interpolate(a, b, t) {
    const c = Math.max(0, Math.min(1, t));
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * c,
      longitude: a.longitude + (b.longitude - a.longitude) * c
    };
  }

  function bearing(a, b) {
    const lat1 = radians(a.latitude), lat2 = radians(b.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (degrees(Math.atan2(y, x)) + 360) % 360;
  }

  function bearingDelta(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  function closestPointOnSegment(point, a, b) {
    const origin = {
      latitude: (a.latitude + b.latitude) / 2,
      longitude: (a.longitude + b.longitude) / 2
    };
    const scale = metersPerDegree(origin.latitude);
    function toXY(c) {
      return {
        x: (c.longitude - origin.longitude) * scale.lon,
        y: (c.latitude - origin.latitude) * scale.lat
      };
    }
    const pa = toXY(a), pb = toXY(b), pp = toXY(point);
    const vx = pb.x - pa.x, vy = pb.y - pa.y;
    const lengthSq = vx * vx + vy * vy;
    const t = lengthSq < 1e-6 ? 0 : Math.max(0, Math.min(1, ((pp.x - pa.x) * vx + (pp.y - pa.y) * vy) / lengthSq));
    const snapped = interpolate(a, b, t);
    return { t, coordinate: snapped, distanceMeters: haversine(point, snapped) };
  }

  function displayPK(meters) {
    const sign = meters < -0.5 ? "-" : "";
    const abs = Math.abs(meters);
    const km = Math.trunc(abs / 1000);
    const rem = Math.trunc(abs % 1000);
    return "PK " + sign + km + "+" + String(rem).padStart(3, "0");
  }

  function parsePK(raw) {
    let trimmed = String(raw || "").trim().toUpperCase().replace("PK", "").trim().replace(",", ".");
    if (!trimmed) return null;
    const plus = trimmed.indexOf("+");
    if (plus >= 0) {
      const kmPart = trimmed.slice(0, plus).trim();
      const mPart = trimmed.slice(plus + 1).trim();
      const km = parseFloat(kmPart);
      const rem = parseFloat(mPart || "0");
      if (!Number.isFinite(km) || !Number.isFinite(rem)) return null;
      const sign = kmPart.startsWith("-") || km < 0 ? -1 : 1;
      return sign * (Math.abs(km) * 1000 + Math.abs(rem));
    }
    const value = parseFloat(trimmed);
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) >= 1000 || trimmed.length >= 4) return value;
    return value * 1000;
  }

  function prepareLine(file) {
    const points = (file.points || []).map((p, i) => ({
      sequence: p.sequence ?? i,
      pkMeters: p.pkMeters,
      coordinate: { latitude: p.latitude, longitude: p.longitude },
      name: p.name,
      interpolation: p.interpolation || "linear"
    }));
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      segments.push({
        index: i,
        start: a,
        end: b,
        lengthMeters: Math.max(haversine(a.coordinate, b.coordinate), 0.01),
        bearingDegrees: bearing(a.coordinate, b.coordinate),
        minLatitude: Math.min(a.coordinate.latitude, b.coordinate.latitude),
        maxLatitude: Math.max(a.coordinate.latitude, b.coordinate.latitude),
        minLongitude: Math.min(a.coordinate.longitude, b.coordinate.longitude),
        maxLongitude: Math.max(a.coordinate.longitude, b.coordinate.longitude),
        pkDiscontinuity: a.interpolation === "none"
      });
    }
    const pks = points.map((p) => p.pkMeters);
    return {
      id: file.lineId,
      name: file.name,
      originName: file.originName,
      destinationName: file.destinationName,
      isOfficialData: !!file.isOfficialData,
      disclaimer: file.disclaimer || "",
      maxSnapDistanceMeters: file.maxSnapDistanceMeters || 150,
      points,
      segments,
      minPKMeters: pks.length ? Math.min.apply(null, pks) : 0,
      maxPKMeters: pks.length ? Math.max.apply(null, pks) : 0
    };
  }

  function coordinateAtPK(line, pk) {
    for (const segment of line.segments) {
      if (segment.pkDiscontinuity) continue;
      const lo = Math.min(segment.start.pkMeters, segment.end.pkMeters);
      const hi = Math.max(segment.start.pkMeters, segment.end.pkMeters);
      if (pk + 0.5 >= lo && pk - 0.5 <= hi) {
        const span = segment.end.pkMeters - segment.start.pkMeters;
        const t = Math.abs(span) < 1e-6 ? 0 : (pk - segment.start.pkMeters) / span;
        return interpolate(segment.start.coordinate, segment.end.coordinate, t);
      }
    }
    if (!line.points.length) return null;
    return line.points.reduce((best, p) =>
      Math.abs(p.pkMeters - pk) < Math.abs(best.pkMeters - pk) ? p : best
    ).coordinate;
  }

  function project(coordinate, line, maxDistance) {
    const cap = maxDistance ?? line.maxSnapDistanceMeters;
    const margin = 0.004;
    let best = null;
    function consider(segment) {
      const closest = closestPointOnSegment(coordinate, segment.start.coordinate, segment.end.coordinate);
      if (!best || closest.distanceMeters < best.closest.distanceMeters) {
        best = { segment, closest };
      }
    }
    for (const segment of line.segments) {
      if (
        coordinate.latitude < segment.minLatitude - margin ||
        coordinate.latitude > segment.maxLatitude + margin ||
        coordinate.longitude < segment.minLongitude - margin ||
        coordinate.longitude > segment.maxLongitude + margin
      ) continue;
      consider(segment);
    }
    if (!best) line.segments.forEach(consider);
    if (!best) return null;
    const pk = best.segment.pkDiscontinuity
      ? (best.closest.t < 0.5 ? best.segment.start.pkMeters : best.segment.end.pkMeters)
      : best.segment.start.pkMeters + best.closest.t * (best.segment.end.pkMeters - best.segment.start.pkMeters);
    return {
      lineId: line.id,
      segmentIndex: best.segment.index,
      t: best.closest.t,
      snappedCoordinate: best.closest.coordinate,
      distanceToTrack: best.closest.distanceMeters,
      pkMeters: pk,
      trackBearingDegrees: best.segment.bearingDegrees,
      withinSnap: best.closest.distanceMeters <= cap
    };
  }

  function createEngine(lines, config) {
    config = Object.assign({
      maxSnapDistanceMeters: 150,
      lineSwitchMarginMeters: 40,
      lineSwitchDwellCount: 4,
      lockBonusMeters: 25,
      headingMinSpeed: 4,
      headingPenaltyMeters: 30,
      directionConfirmMeters: 40,
      tunnelTimeoutSeconds: 12,
      approachingThresholdMeters: 1000
    }, config || {});

    let lockedLineId = null;
    let challengerId = null;
    let challengerHits = 0;
    let pkAnchor = null;
    let lastPK = null;
    let direction = "unknown";
    let lastLive = null;
    let lastPosition = null;
    let smoothed = null;

    function reset() {
      lockedLineId = null;
      challengerId = null;
      challengerHits = 0;
      pkAnchor = null;
      lastPK = null;
      direction = "unknown";
      lastLive = null;
      lastPosition = null;
      smoothed = null;
    }

    function updateDirection(pk) {
      const previous = pkAnchor != null ? pkAnchor : lastPK;
      lastPK = pk;
      if (previous == null) {
        pkAnchor = pk;
        return direction;
      }
      const delta = pk - previous;
      if (Math.abs(delta) >= config.directionConfirmMeters) {
        direction = delta > 0 ? "increasing" : "decreasing";
        pkAnchor = pk;
      }
      return direction;
    }

    function confidence(accuracy, distance, contested, dwell) {
      if (accuracy < 0) return "none";
      if (distance > config.maxSnapDistanceMeters) return "none";
      if (accuracy > 80 || distance > 80) return "low";
      if (contested && dwell < 3) return "low";
      if (accuracy > 25 || distance > 40 || dwell < 2) return "medium";
      return "high";
    }

    function ingest(sample) {
      if (!lines.length) {
        return { status: "noRailwayData", position: null, alert: noneAlert() };
      }
      if (!sample || !Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
        return holdLost(sample);
      }

      const raw = { latitude: sample.latitude, longitude: sample.longitude };
      const alpha = 0.45;
      smoothed = smoothed
        ? {
            latitude: smoothed.latitude + (raw.latitude - smoothed.latitude) * alpha,
            longitude: smoothed.longitude + (raw.longitude - smoothed.longitude) * alpha
          }
        : raw;

      const accuracy = sample.accuracy;
      if (!(accuracy >= 0) || accuracy > 250) return holdLost(sample);

      const candidates = [];
      for (const line of lines) {
        const cap = Math.max(line.maxSnapDistanceMeters, config.maxSnapDistanceMeters);
        const proj = project(smoothed, line, cap);
        if (!proj || proj.distanceToTrack > cap) continue;
        let score = proj.distanceToTrack;
        if (line.id === lockedLineId) score -= config.lockBonusMeters;
        if (sample.course >= 0 && sample.speed >= config.headingMinSpeed) {
          const orthogonal = Math.min(
            bearingDelta(sample.course, proj.trackBearingDegrees),
            bearingDelta(sample.course, (proj.trackBearingDegrees + 180) % 360)
          );
          score += Math.min(1, orthogonal / 90) * config.headingPenaltyMeters;
        }
        candidates.push({ line, proj, score });
      }
      candidates.sort((a, b) => a.score - b.score);
      if (!candidates.length) {
        return {
          status: "noLineDetected",
          position: null,
          accuracy,
          speed: sample.speed,
          demo: lines.some((l) => !l.isOfficialData),
          alert: noneAlert()
        };
      }

      let winner = candidates[0];
      const contested = candidates.length >= 2 &&
        Math.abs(candidates[0].proj.distanceToTrack - candidates[1].proj.distanceToTrack) < 35;

      if (lockedLineId) {
        const locked = candidates.find((c) => c.line.id === lockedLineId);
        if (locked) {
          if (winner.line.id !== lockedLineId && locked.score - winner.score >= config.lineSwitchMarginMeters) {
            if (challengerId === winner.line.id) challengerHits += 1;
            else { challengerId = winner.line.id; challengerHits = 1; }
            winner = challengerHits >= config.lineSwitchDwellCount ? winner : locked;
            if (winner.line.id !== lockedLineId) {
              lockedLineId = winner.line.id;
              challengerId = null;
              challengerHits = 0;
            }
          } else {
            challengerId = null;
            challengerHits = 0;
            winner = locked;
          }
        } else {
          lockedLineId = winner.line.id;
        }
      } else {
        lockedLineId = winner.line.id;
      }

      const dir = updateDirection(winner.proj.pkMeters);
      lastLive = sample.timestamp || Date.now();
      const conf = confidence(accuracy, winner.proj.distanceToTrack, contested, 4);
      const position = {
        line: winner.line,
        pkMeters: winner.proj.pkMeters,
        display: displayPK(winner.proj.pkMeters),
        snapped: winner.proj.snappedCoordinate,
        raw,
        distanceToTrack: winner.proj.distanceToTrack,
        confidence: conf === "none" ? "low" : conf,
        direction: dir,
        trackBearing: winner.proj.trackBearingDegrees,
        deadReckoned: false
      };
      lastPosition = position;
      const status = sample.simulated ? "simulated" : (contested && conf !== "high" ? "multipleLineCandidates" : "tracking");
      return {
        status,
        position,
        accuracy,
        speed: sample.speed,
        demo: !winner.line.isOfficialData,
        alert: evaluateZones(position.pkMeters, position.line.id, dir, sample.zones || [], config.approachingThresholdMeters)
      };
    }

    function holdLost(sample) {
      if (!lastPosition) {
        return { status: "waitingForFix", position: null, alert: noneAlert(), accuracy: sample && sample.accuracy, speed: sample && sample.speed, demo: true };
      }
      const now = (sample && sample.timestamp) || Date.now();
      const elapsed = (now - (lastLive || now)) / 1000;
      if (elapsed > config.tunnelTimeoutSeconds && lastPosition.direction !== "unknown" && sample && sample.speed > 1) {
        const dt = Math.min(elapsed, 2);
        const pk = lastPosition.pkMeters + (lastPosition.direction === "increasing" ? 1 : -1) * sample.speed * dt;
        const snapped = coordinateAtPK(lastPosition.line, pk) || lastPosition.snapped;
        lastPosition = Object.assign({}, lastPosition, {
          pkMeters: pk,
          display: displayPK(pk),
          snapped,
          confidence: "low",
          deadReckoned: true
        });
        lastPK = pk;
      } else {
        lastPosition = Object.assign({}, lastPosition, { confidence: "low", deadReckoned: true });
      }
      return {
        status: "gpsLost",
        position: lastPosition,
        accuracy: sample && sample.accuracy,
        speed: sample && sample.speed,
        demo: !lastPosition.line.isOfficialData,
        alert: evaluateZones(lastPosition.pkMeters, lastPosition.line.id, lastPosition.direction, (sample && sample.zones) || [], config.approachingThresholdMeters)
      };
    }

    return { ingest, reset, coordinateAtPK, lines, config };
  }

  function noneAlert() {
    return { level: "normal", symbol: "🟢", title: "NORMAL", subtitle: "", distanceMeters: null, zone: null };
  }

  function remainingToExit(pk, zone, direction) {
    if (direction === "increasing") return Math.max(0, zone.upper - pk);
    if (direction === "decreasing") return Math.max(0, pk - zone.lower);
    return Math.min(Math.max(0, pk - zone.lower), Math.max(0, zone.upper - pk));
  }

  function distanceToEntry(pk, zone, direction) {
    if (direction === "increasing") {
      const d = zone.lower - pk;
      return d > 0 ? d : null;
    }
    if (direction === "decreasing") {
      const d = pk - zone.upper;
      return d > 0 ? d : null;
    }
    if (pk < zone.lower) return zone.lower - pk;
    if (pk > zone.upper) return pk - zone.upper;
    return 0;
  }

  function formatDistance(meters) {
    const m = Math.round(meters);
    if (m >= 1000) return (m / 1000).toFixed(1) + " km";
    return m + " m";
  }

  function evaluateZones(pk, lineId, direction, zones, threshold) {
    threshold = threshold == null ? 1000 : threshold;
    const active = (zones || []).filter((z) => z.enabled && z.lineId === lineId);
    if (!active.length) return noneAlert();
    const inside = active.filter((z) => pk >= z.lower && pk <= z.upper);
    if (inside.length) {
      inside.sort((a, b) => remainingToExit(pk, a, direction) - remainingToExit(pk, b, direction));
      const primary = inside[0];
      return {
        level: "inside",
        symbol: "🔴",
        title: "VOUS ÊTES DANS LA ZONE",
        subtitle: inside.length === 1 ? primary.name : "Zones : " + inside.map((z) => z.name).join(", "),
        distanceMeters: remainingToExit(pk, primary, direction),
        zone: primary
      };
    }
    const ahead = [];
    for (const zone of active) {
      const d = distanceToEntry(pk, zone, direction);
      if (d != null && d > 0 && d <= threshold) ahead.push({ zone, d });
    }
    if (!ahead.length) return noneAlert();
    ahead.sort((a, b) => a.d - b.d);
    return {
      level: "approaching",
      symbol: "🟠",
      title: "ZONE À PROXIMITÉ",
      subtitle: "Entrée dans la zone dans " + formatDistance(ahead[0].d),
      distanceMeters: ahead[0].d,
      zone: ahead[0].zone
    };
  }

  function normalizeZone(z) {
    const start = z.startPKMeters;
    const end = z.endPKMeters;
    return Object.assign({}, z, {
      lower: Math.min(start, end),
      upper: Math.max(start, end),
      enabled: z.enabled !== false
    });
  }

  global.PKRail = {
    haversine,
    closestPointOnSegment,
    interpolate,
    displayPK,
    parsePK,
    prepareLine,
    project,
    coordinateAtPK,
    createEngine,
    evaluateZones,
    normalizeZone,
    formatDistance
  };
})(typeof window !== "undefined" ? window : global);
