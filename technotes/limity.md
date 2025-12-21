W **MeshCore** obowiązuje **dość rygorystyczny limit długości pojedynczej wiadomości**, wynikający bezpośrednio z ograniczeń LoRa.

### 🔹 Limit długości wiadomości

* **Maksymalnie ~200–240 bajtów payloadu**
* W praktyce **bezpiecznie przyjmuj ~180–200 bajtów**, bo część danych zajmują:

  * nagłówki protokołu MeshCore,
  * adresowanie,
  * metadane routingu,
  * CRC / kontrola integralności.

To oznacza:

* **kilkadziesiąt znaków tekstu** (zależnie od kodowania),
* raczej **krótkie komunikaty**, nie „SMS-y” ani tym bardziej bloki tekstu.

### 🔹 Co się dzieje przy dłuższej wiadomości?

* MeshCore **tnie ją na fragmenty (fragmentation)**,
* fragmenty są wysyłane osobno i składane u odbiorcy,
* **każdy fragment zwiększa czas transmisji i ryzyko utraty**, szczególnie:

  * przy niskim SF,
  * w zatłoczonej sieci,
  * na dalekich hopach.

Dlatego:

> **zalecenie praktyczne:** traktuj MeshCore jak **pager / radio tekstowe**, a nie komunikator.

### 🔹 Porównanie (dla intuicji)

* 1 znak ASCII ≈ 1 bajt
* 180 bajtów ≈

  * ~180 znaków ASCII
  * ~90–120 znaków UTF-8 (polskie znaki, emoji → szybciej zjadają limit)

### 🔹 Dobre praktyki

* używaj **krótkich, rzeczowych komunikatów**,
* unikaj emoji i znaków narodowych, jeśli zasięg/stabilność jest krytyczna,
* jeśli musisz przesłać więcej danych:

  * podziel treść logicznie (kilka wiadomości),
  * rozważ **out-of-band** (np. MeshCore tylko do „powiadomień”).

Jeśli chcesz, mogę:

* rozpisać **dokładną strukturę ramki MeshCore (ile bajtów na co)**,
* porównać to z **Meshtastic** (tam limity są trochę inne),
* albo pomóc dobrać **SF/BW/CR**, żeby fragmentacja była możliwie bezpieczna.
