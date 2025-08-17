$(document).ready(function(){
    if ($('.memorizePanel').length != 0) {

        $('.flipCard').click(function(){
            if ($('.cardFront').is(":visible") == true) {
                $('.cardFront').hide();
                $('.cardBack').show();
            } else {
                $('.cardFront').show();
                $('.cardBack').hide();
            }
        });

        // Get a Hint button handler
        $(document).on('click', '#load-hint', function (e) {
            e.preventDefault();

            var $btn = $(this); // the <a id="load-hint">
            var cardId = $btn.data('cardId'); // reads data-card-id
            if (!cardId) return;

            var $hint = $('#hint');
            if (!$hint.length) return;
            var $label = $('#hint-toggle-text');

            // If a hint has been loaded before and is currently visible, hide it (toggle off)
            if ($hint.is(':visible') && $hint.data('loaded') === true) {
                $hint.hide();
                if ($label.length) $label.text('Get a Hint');
                return;
            }

            // If a hint has been loaded before and is currently hidden, show it without refetching (toggle on)
            if (!$hint.is(':visible') && $hint.data('loaded') === true) {
                $hint.show();
                if ($label.length) $label.text('Hide the Hint');
                return;
            }

            // Otherwise, first-time fetch
            $hint.show();
            $hint.text('Loading hint…');

            $.ajax({
                url: '/hint/' + encodeURIComponent(cardId),
                method: 'GET',
                dataType: 'json'
            })
            .done(function (resp) {
                var text = (resp && resp.hint) ? resp.hint : 'No hint available';
                $hint.text(text);
                // Mark as loaded so subsequent clicks can toggle without refetch
                $hint.data('loaded', true);
                if ($label.length) $label.text('Hide the Hint');
            })
            .fail(function (xhr) {
                console.error('Failed to load hint:', xhr);
                $hint.text('Failed to load hint. Please try again.');
                if ($label.length) $label.text('Get a Hint');
            });
        });
    }

    if ($('.cardForm').length != 0) {

        $('.cardForm').submit(function(){

            var frontTrim = $.trim($('#front').val());
            $('#front').val(frontTrim);
            var backTrim = $.trim($('#back').val());
            $('#back').val(backTrim);

            if (! $('#front').val() || ! $('#back').val()) {
                return false;
            }
        });
    }

    if ($('.editPanel').length != 0) {

        function checkit() {
            var checkedVal = $('input[name=type]:checked').val();
            var checkedId = $('input[name=type]:checked').attr("id");
            if (checkedVal === undefined) {
                // hide the fields
                $('.fieldFront').hide();
                $('.fieldBack').hide();
                $('.saveButton').hide();
            } else {
                $('.toggleButton').removeClass('toggleSelected');
            
                if(checkedId === undefined) {
                    $(this).addClass('toggleSelected');
                } else {
                    $('label[for='+ checkedId +']').addClass('toggleSelected');
                }

                $('.fieldFront').show();
                $('.fieldBack').show();
                $('.saveButton').show();
            }
        }

        $('.toggleButton').click(checkit);

        checkit();
    }

    // to remove the short delay on click on touch devices
    FastClick.attach(document.body);
});
